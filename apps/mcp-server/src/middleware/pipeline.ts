/**
 * Tool middleware (MCP-002; SR-001, SR-006, NFR-004, NFR-013, FR-045; mcp-tool-contracts §2).
 *
 * Every tool call goes through one pipeline:
 * 1. tier check (`tierFor`): prohibited calls are denied; P1+ tools are denied with `E_POLICY_UNAVAILABLE` while
 *    the user policy is missing or invalid (fail safe);
 * 2. `tool.call` audit event — if it cannot be written the tool does not run (`E_STORAGE_UNAVAILABLE`);
 * 3. idempotency (tools whose input has `idempotencyKey`): same key and digest replays the stored result, same key
 *    with a different digest is `E_IDEMPOTENCY_CONFLICT`;
 * 4. the bound use case (contract validation of input and output happens there);
 * 5. untrusted-field labelling, the 20,000-character output cap (a violation is a server bug: `E_INTERNAL`) and the
 *    text summary;
 * 6. `tool.result` audit event, metrics and a log record.
 * Paged tools fit their pages to the cap themselves with `paginate` and HMAC cursors.
 */
import {
  digest,
  ERROR_CATALOG,
  OUTPUT_CAP_CHARS,
  TOOLS,
  toolError,
  type AuditSink,
  type IdempotencyStore,
  type Logger,
  type MetricsRegistry,
  type ToolError,
  type ToolName,
} from '@autotest/core';
import { tierFor } from '@autotest/policy';
import type { CallContext, Workflow } from '@autotest/workflow';
import { summarizeError, summarizeSuccess } from './summary.ts';
import { labelUntrusted } from './untrusted.ts';

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface PipelineDeps {
  readonly workflow: Workflow;
  readonly audit: AuditSink;
  readonly idempotency: IdempotencyStore;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly now: () => Date;
  readonly sessionId: string;
  readonly newToolCallId: () => string;
  readonly policyAvailable: boolean;
  readonly actor?: CallContext['actor'];
  readonly capChars?: number;
  readonly idempotencyTtlMs?: number;
}

export type ToolPipeline = (name: ToolName, args: unknown) => Promise<ToolResult>;

const HANDLE = /^[a-z]{2,8}_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createToolPipeline(deps: PipelineDeps): ToolPipeline {
  const cap = deps.capChars ?? OUTPUT_CAP_CHARS;
  const ttl = deps.idempotencyTtlMs ?? 24 * 3_600_000;

  return async (name, args) => {
    const started = Date.now();
    const toolCallId = deps.newToolCallId();
    const log = deps.logger.child({ toolCallId });
    const ctx: CallContext = { sessionId: deps.sessionId, toolCallId, actor: deps.actor ?? 'agent' };
    const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const tier = tierFor(name, typeof input['action'] === 'string' ? { action: input['action'] as never } : {});
    const subjects = new Set<string>();
    collectHandles(input, subjects);

    const finish = async (result: ToolResult, code: string | null): Promise<ToolResult> => {
      const latencyMs = Date.now() - started;
      if (result.structuredContent && !result.isError) collectHandles(result.structuredContent, subjects);
      try {
        await deps.audit.append({
          ts: iso(deps.now()),
          actor: deps.actor ?? 'agent',
          kind: 'tool.result',
          subjectRefs: [...subjects].slice(0, 20),
          data: { tool: name, toolCallId, result: code ?? 'ok', latencyMs },
        });
      } catch {
        log.error('audit.write_failed', { data: { tool: name, kind: 'tool.result' } });
      }
      const category = code ? (ERROR_CATALOG[code as keyof typeof ERROR_CATALOG]?.category ?? 'internal') : 'ok';
      deps.metrics.inc('tool_calls_total', { tool: name, result: category });
      deps.metrics.observe('tool_latency_ms', latencyMs, { tool: name });
      log.info(code ? 'tool.call.failed' : 'tool.call.completed', {
        durationMs: latencyMs,
        ...(code ? { code: code as ToolError['error']['code'] } : {}),
        data: { tool: name, tier },
      });
      return result;
    };
    const failWith = (e: ToolError) =>
      finish(
        {
          isError: true,
          content: [{ type: 'text', text: summarizeError(e) }],
          structuredContent: e as unknown as Record<string, unknown>,
        },
        e.error.code,
      );

    // 1. Tier check.
    if (tier === 'prohibited') return failWith(toolError('E_POLICY_DENIED', `${name} is not permitted`, []));
    if (tier !== 'P0' && !deps.policyAvailable)
      return failWith(
        toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', [
          'Fix ~/.autotest/config.yaml, then run `autotest doctor`.',
        ]),
      );

    // 2. tool.call audit (fail closed).
    try {
      await deps.audit.append({
        ts: iso(deps.now()),
        actor: deps.actor ?? 'agent',
        kind: 'tool.call',
        subjectRefs: [...subjects].slice(0, 20),
        data: { tool: name, toolCallId, tier, inputDigest: digest(input) },
      });
    } catch {
      return failWith(
        toolError('E_STORAGE_UNAVAILABLE', 'the audit log could not be written; the call was not executed', [
          'Run `autotest doctor`',
        ]),
      );
    }

    // 3. Idempotency.
    const key =
      typeof input['idempotencyKey'] === 'string' && IDEM_KEY.test(input['idempotencyKey'])
        ? input['idempotencyKey']
        : undefined;
    const { idempotencyKey: _k, ...rest } = input;
    void _k;
    const requestDigest = digest(rest);
    if (key) {
      const prior = await deps.idempotency.get(name, key, deps.now());
      if (prior && prior.requestDigest !== requestDigest)
        return failWith(
          toolError('E_IDEMPOTENCY_CONFLICT', 'this idempotency key was used with a different request', [
            'Use a new idempotencyKey',
          ]),
        );
      if (prior) return success(prior.result as Record<string, unknown>, true);
    }

    // 4. The use case (contract-validated).
    let outcome;
    try {
      outcome = await deps.workflow[name](args, ctx);
    } catch {
      return failWith(
        toolError('E_INTERNAL', `Unexpected error in ${name}`, ['Report this with the correlation id'], {
          correlationId: toolCallId,
        }),
      );
    }
    if (!outcome.ok) return failWith(outcome.error);

    // 5. Labelling, cap, summary.
    const output = labelUntrusted(name, outcome.value as Record<string, unknown>);
    if (JSON.stringify(output).length > cap) {
      log.error('output.cap_exceeded', { data: { tool: name } });
      return failWith(
        toolError(
          'E_INTERNAL',
          `${name} produced output above the ${cap}-character cap`,
          ['Report this with the correlation id'],
          { correlationId: toolCallId },
        ),
      );
    }
    if (key) {
      const stored = await deps.idempotency.putIfAbsent(
        {
          tool: name,
          key,
          requestDigest,
          result: output,
          expiresAt: new Date(deps.now().getTime() + ttl).toISOString(),
        },
        deps.now(),
      );
      if (stored.requestDigest !== requestDigest)
        return failWith(
          toolError('E_IDEMPOTENCY_CONFLICT', 'this idempotency key was used with a different request', [
            'Use a new idempotencyKey',
          ]),
        );
      return success(stored.result as Record<string, unknown>, stored.result !== output);
    }
    return success(output, false);

    function success(out: Record<string, unknown>, replayed: boolean): Promise<ToolResult> {
      const text = `${replayed ? '(replayed) ' : ''}${summarizeSuccess(name, out)}`;
      return finish({ content: [{ type: 'text', text }], structuredContent: out }, null);
    }
  };

  function collectHandles(v: unknown, into: Set<string>, depth = 0): void {
    if (into.size >= 20 || depth > 4) return;
    if (typeof v === 'string') {
      if (HANDLE.test(v)) into.add(v);
    } else if (Array.isArray(v)) v.slice(0, 50).forEach((x) => collectHandles(x, into, depth + 1));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collectHandles(x, into, depth + 1);
  }
}

/** Exposed for tests: whether a tool's input carries an idempotency key field. */
export const IDEMPOTENT_TOOLS: readonly ToolName[] = TOOLS.filter(
  (t) => 'shape' in t.input && 'idempotencyKey' in (t.input as unknown as { shape: object }).shape,
).map((t) => t.name);
