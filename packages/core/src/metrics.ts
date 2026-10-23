/**
 * Metric registry (OBS-003; NFR-008; observability §4). Counters, histograms and gauges are kept in memory, emitted
 * as `metric` log records and summarized for `doctor --stats`. Labels are guarded: only the declared label names,
 * values that look like identifiers (never free text from repositories or PRs), and at most `maxSeries` series per
 * metric; anything beyond is folded into a single `_overflow` series and counted.
 */
import type { Logger } from './log.ts';

export type MetricType = 'counter' | 'histogram' | 'gauge';

export interface MetricDefinition {
  readonly type: MetricType;
  readonly labels: readonly string[];
}

/** The canonical metric set (observability §4; docs-sync tested). */
export const METRIC_DEFINITIONS = {
  tool_calls_total: { type: 'counter', labels: ['tool', 'result'] },
  tool_latency_ms: { type: 'histogram', labels: ['tool'] },
  runs_total: { type: 'counter', labels: ['state'] },
  run_duration_ms: { type: 'histogram', labels: ['adapter'] },
  queue_depth: { type: 'gauge', labels: [] },
  tests_total: { type: 'counter', labels: ['outcome', 'adapter'] },
  retries_total: { type: 'counter', labels: ['adapter'] },
  flaky_total: { type: 'counter', labels: ['adapter'] },
  gate_decisions_total: { type: 'counter', labels: ['decision'] },
  gate_rule_hits_total: { type: 'counter', labels: ['ruleId'] },
  authorization_denials_total: { type: 'counter', labels: ['reason'] },
  approvals_total: { type: 'counter', labels: ['source', 'assurance', 'outcome'] },
  artifacts_quarantined_total: { type: 'counter', labels: ['reason'] },
  redaction_findings_total: { type: 'counter', labels: ['class'] },
  github_calls_total: { type: 'counter', labels: ['endpoint', 'status'] },
  cancel_pending_total: { type: 'counter', labels: [] },
  reconciliation_actions_total: { type: 'counter', labels: ['action'] },
  storage_bytes: { type: 'gauge', labels: ['area'] },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
export type Labels = Readonly<Record<string, string>>;

export const DEFAULT_BUCKETS_MS = [
  10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000,
] as const;
/** Identifier-like label values only (tool names, enum values, rule ids, adapter ids). */
export const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const OVERFLOW = '_overflow';
const INVALID = '_invalid';

export interface SeriesSnapshot {
  readonly labels: Labels;
  readonly value?: number;
  readonly count?: number;
  readonly sum?: number;
  readonly buckets?: Readonly<Record<string, number>>;
}

export type MetricsSnapshot = Readonly<
  Record<string, { readonly type: MetricType; readonly series: readonly SeriesSnapshot[] }>
>;

export interface MetricsRegistry {
  inc(name: MetricName, labels?: Labels, by?: number): void;
  observe(name: MetricName, value: number, labels?: Labels): void;
  set(name: MetricName, value: number, labels?: Labels): void;
  snapshot(): MetricsSnapshot;
  /** Writes one `metric` info record per series. */
  emit(logger: Logger): void;
  /** Label sets rejected or folded by the guard (for doctor). */
  readonly guardHits: () => number;
}

interface Series {
  labels: Labels;
  value: number;
  count: number;
  sum: number;
  buckets: number[];
}

export function createMetricsRegistry(opts: { maxSeries?: number; buckets?: readonly number[] } = {}): MetricsRegistry {
  const maxSeries = opts.maxSeries ?? 100;
  const buckets = opts.buckets ?? DEFAULT_BUCKETS_MS;
  const store = new Map<MetricName, Map<string, Series>>();
  let guard = 0;

  const series = (name: MetricName, type: MetricType, labels: Labels): Series => {
    const def: MetricDefinition = METRIC_DEFINITIONS[name];
    if (!def) throw new TypeError(`unknown metric ${String(name)}`);
    if (def.type !== type) throw new TypeError(`${name} is a ${def.type}`);
    const clean: Record<string, string> = {};
    for (const l of def.labels) {
      const v = labels[l];
      if (v === undefined || !LABEL_VALUE.test(v)) guard++;
      clean[l] = v !== undefined && LABEL_VALUE.test(v) ? v : INVALID;
    }
    if (Object.keys(labels).some((k) => !def.labels.includes(k))) guard++;
    let m = store.get(name);
    if (!m) store.set(name, (m = new Map()));
    let key = JSON.stringify(clean);
    if (!m.has(key) && m.size >= maxSeries) {
      guard++;
      const folded = Object.fromEntries(def.labels.map((l) => [l, OVERFLOW]));
      key = JSON.stringify(folded);
      Object.assign(clean, folded);
    }
    let s = m.get(key);
    if (!s) m.set(key, (s = { labels: { ...clean }, value: 0, count: 0, sum: 0, buckets: buckets.map(() => 0) }));
    return s;
  };

  return {
    inc(name, labels = {}, by = 1) {
      if (!(by >= 0)) throw new RangeError('counters only increase');
      series(name, 'counter', labels).value += by;
    },
    observe(name, value, labels = {}) {
      if (!Number.isFinite(value) || value < 0) return;
      const s = series(name, 'histogram', labels);
      s.count++;
      s.sum += value;
      buckets.forEach((b, i) => {
        if (value <= b) s.buckets[i]!++;
      });
    },
    set(name, value, labels = {}) {
      if (!Number.isFinite(value)) return;
      series(name, 'gauge', labels).value = value;
    },
    snapshot() {
      const out: Record<string, { type: MetricType; series: SeriesSnapshot[] }> = {};
      for (const [name, m] of store) {
        const type = METRIC_DEFINITIONS[name].type;
        out[name] = {
          type,
          series: [...m.values()].map((s) =>
            type === 'histogram'
              ? {
                  labels: s.labels,
                  count: s.count,
                  sum: s.sum,
                  buckets: Object.fromEntries([
                    ...buckets.map((b, i) => [`le_${b}`, s.buckets[i]!]),
                    ['le_inf', s.count],
                  ]),
                }
              : { labels: s.labels, value: s.value },
          ),
        };
      }
      return out;
    },
    emit(logger) {
      for (const [name, m] of Object.entries(this.snapshot()))
        for (const s of m.series) logger.info('metric', { data: { name, type: m.type, ...s } });
    },
    guardHits: () => guard,
  };
}
