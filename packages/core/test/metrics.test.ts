import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, createMetricsRegistry, METRIC_DEFINITIONS, type MetricName } from '@autotest/core';

describe('OBS-003 metrics', () => {
  it('defines exactly the metrics of observability §4 (docs-sync)', () => {
    const doc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../docs/observability-and-failure-analysis.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('## 4. Metrics'), doc.indexOf('## 5. Audit trail'));
    const fromDoc: Record<string, { type: string; labels: string[] }> = {};
    for (const line of section.split('\n').filter((l) => /^\| `/.test(l))) {
      const [names, type, labels] = line
        .split('|')
        .slice(1, 4)
        .map((c) => c.trim());
      const labelNames = [...labels!.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!);
      for (const n of [...names!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!))
        fromDoc[n] = { type: type!, labels: labelNames };
    }
    const fromCode = Object.fromEntries(
      Object.entries(METRIC_DEFINITIONS).map(([n, d]) => [n, { type: d.type, labels: [...d.labels] }]),
    );
    expect(fromCode).toEqual(fromDoc);
  });

  it('counts, observes into buckets and sets gauges', () => {
    const m = createMetricsRegistry();
    m.inc('tool_calls_total', { tool: 'run_tests', result: 'ok' });
    m.inc('tool_calls_total', { tool: 'run_tests', result: 'ok' }, 2);
    m.observe('tool_latency_ms', 42, { tool: 'run_tests' });
    m.observe('tool_latency_ms', 4200, { tool: 'run_tests' });
    m.set('queue_depth', 3);
    const s = m.snapshot();
    expect(s['tool_calls_total']?.series).toEqual([{ labels: { tool: 'run_tests', result: 'ok' }, value: 3 }]);
    expect(s['tool_latency_ms']?.series[0]).toMatchObject({
      count: 2,
      sum: 4242,
      buckets: { le_10: 0, le_50: 1, le_5000: 2, le_inf: 2 },
    });
    expect(s['queue_depth']?.series).toEqual([{ labels: {}, value: 3 }]);
  });

  it('guards labels: free text and undeclared labels never become series values', () => {
    const m = createMetricsRegistry();
    m.inc('gate_rule_hits_total', { ruleId: 'GB-01' });
    m.inc('gate_rule_hits_total', { ruleId: 'Badge shows "3" for jane@example.com' });
    m.inc('tests_total', { outcome: 'passed', adapter: 'flutter', testName: 'leak' });
    const s = JSON.stringify(m.snapshot());
    expect(s).not.toContain('example.com');
    expect(s).not.toContain('leak');
    expect(m.snapshot()['gate_rule_hits_total']?.series.map((x) => x.labels['ruleId'])).toEqual(['GB-01', '_invalid']);
    expect(m.guardHits()).toBe(2);
  });

  it('caps series per metric (cardinality guard)', () => {
    const m = createMetricsRegistry({ maxSeries: 3 });
    for (let i = 0; i < 10; i++) m.inc('authorization_denials_total', { reason: `r${i}` });
    const series = m.snapshot()['authorization_denials_total']!.series;
    expect(series).toHaveLength(4);
    expect(series.at(-1)).toEqual({ labels: { reason: '_overflow' }, value: 7 });
  });

  it('rejects misuse and emits metric records through the logger', () => {
    const m = createMetricsRegistry();
    expect(() => m.inc('queue_depth' as MetricName)).toThrow(TypeError);
    expect(() => m.inc('runs_total', { state: 'completed' }, -1)).toThrow(RangeError);
    m.inc('runs_total', { state: 'completed' });
    const lines: string[] = [];
    m.emit(createLogger({ component: 'metrics', sinks: [{ write: (l) => lines.push(l) }] }));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: 'metric',
      data: { name: 'runs_total', type: 'counter', labels: { state: 'completed' }, value: 1 },
    });
  });
});
