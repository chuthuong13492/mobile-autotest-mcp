/**
 * Run supervisor (EXE-003; FR-023, FR-029, NFR-005; ADR-0007).
 *
 * One supervisor process owns one run. It is the only writer of `events.ndjson` (each record fsynced *before* the
 * supervisor acts on it), `heartbeat.json` and `terminal.json`; the MCP server only observes these files. State
 * changes go through the canonical lifecycle (`transitionRun`), so an impossible transition is a bug, not a state.
 *
 * Cancellation has four triggers: `control.json` (written by the server), SIGTERM, the run wall-clock timeout and
 * the disk quota. Termination is SIGTERM → grace → SIGKILL → verify (`terminateGroup`); survivors move the run to
 * `cancel_pending`, re-checked with back-off until the verification window ends in `infra_error(cancel_unconfirmed)`.
 * `cancelled`/`timed_out` are written only after termination was confirmed.
 *
 * Dispatch-time re-authorization, per-attempt parsing with bounded retries (RUN-005) and evidence collection are
 * hooks; the app's supervisor entrypoint supplies the full re-evaluation (RUN-002) and the adapters.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  digest,
  transitionRun,
  type AuthorizationReason,
  type CancelReason,
  type ExecutionSpec,
  type ProcessIdentity,
  type RunEvent,
  type RunEventInput,
  type RunStatus,
  type TestTarget,
} from '@autotest/core';
import {
  nodeExecPort,
  spawnSpec,
  startTimer,
  terminateGroup,
  verifyGone,
  watchQuota,
  type ExecPort,
  type SpawnContext,
} from '@autotest/exec';
import { validateSpec } from '@autotest/policy';
import {
  appendEvent,
  atomicWriteJson,
  ControlFile,
  iso,
  readJson,
  RunHeader,
  runPaths,
  AttemptResultsFile,
  type TerminalRecord,
} from './files.ts';
import { countOutcomes } from '@autotest/adapter-sdk';
import type { AttemptHooks, AttemptParse } from '../attemptHooks.ts';
import { selectRetryTargets } from '../retry.ts';

export interface DispatchAuthorization {
  readonly result: 'authorized' | 'denied';
  readonly reasons: readonly AuthorizationReason[];
  readonly inputsDigest: string;
}

export interface SupervisorHooks {
  /** Dispatch-time re-authorization (ADR-0006 §4; RUN-002). */
  authorize(header: RunHeader): Promise<DispatchAuthorization>;
  /** Spawn context for one spec, or undefined when the run cannot be executed (e.g. workspace gone). */
  spawnContext(args: {
    header: RunHeader;
    attemptNo: number;
    index: number;
    stdoutPath: string;
    stderrPath: string;
  }): SpawnContext | undefined;
  /** Adapter-driven later-attempt specs and per-attempt parsing (absent: one attempt, no results file). */
  readonly attempts?: AttemptHooks;
  /** Evidence ingestion in the `collecting` state (EVD-001); a throw ends the run in `infra_error(storage_error)`. */
  collect?(header: RunHeader): Promise<void>;
}

export interface SupervisorOptions {
  readonly runId: string;
  readonly dataRoot: string;
  readonly hooks: SupervisorHooks;
  readonly port?: ExecPort;
  readonly now?: () => Date;
  readonly controlPollMs?: number;
  readonly quotaCheckMs?: number;
  /** Install a SIGTERM handler (the detached entrypoint does; in-process tests do not). */
  readonly listenSignals?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSupervisor(opts: SupervisorOptions): Promise<TerminalRecord> {
  const now = opts.now ?? (() => new Date());
  const port = opts.port ?? nodeExecPort();
  const paths = runPaths(opts.dataRoot, opts.runId);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const ts = () => iso(now());
  const emit = (e: RunEvent) => appendEvent(paths.events, e);

  let status: RunStatus = { state: 'queued' };
  let survivors: number[] | undefined;
  const move = (event: RunEventInput) => {
    const next = transitionRun(status, event);
    const reason = event.type === 'cancel_requested' ? event.reason : event.type;
    emit({ t: 'state', ts: ts(), from: status.state, to: next.state, reason });
    status = next;
  };

  // ---- heartbeat
  let seq = 0;
  const beat = () => {
    atomicWriteJson(paths.heartbeat, { ts: ts(), pid: process.pid, seq: seq++, state: status.state });
    emit({ t: 'heartbeat', ts: ts() });
  };

  // ---- cancellation triggers (first one wins)
  let cancelReason: CancelReason | undefined;
  let wake: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => (wake = resolve));
  const requestCancel = (reason: CancelReason) => {
    if (cancelReason) return;
    cancelReason = reason;
    wake();
  };
  const pollControl = () => {
    const c = readJson(paths.control, ControlFile);
    if (c) requestCancel(c.reason);
  };
  const onSigterm = () => {
    pollControl();
    requestCancel('user');
  };

  const header = readJson(paths.header, RunHeader);
  move({ type: 'slot_acquired' });
  if (!header) {
    move({ type: 'prerequisite_failed' });
    return finish({ processes: [] });
  }
  beat();
  const heartbeat = setInterval(beat, header.heartbeatMs);
  const control = setInterval(pollControl, opts.controlPollMs ?? 200);
  if (opts.listenSignals) process.on('SIGTERM', onSigterm);
  let runTimer: { cancel(): void } | undefined;
  let quota: { stop(): void } | undefined;
  const processes: TerminalRecord['processes'] = [];

  try {
    pollControl();
    // ---- preparing: re-authorize and dry-run every spec against current policy
    if (!cancelReason) {
      const auth = await opts.hooks.authorize(header);
      emit({
        t: 'authorization',
        ts: ts(),
        phase: 'dispatch',
        result: auth.result,
        reasons: [...auth.reasons],
        inputsDigest: auth.inputsDigest as `sha256:${string}`,
      });
      if (auth.result !== 'authorized') requestCancel('authorization_invalidated');
    }
    if (!cancelReason && !dryRun(header, opts.hooks, paths)) requestCancel('authorization_invalidated');
    if (cancelReason) {
      await cancelSequence(undefined);
      return finish({ processes });
    }
    move({ type: 'prerequisites_ok' });
    runTimer = startTimer(header.timeouts.runMs, () => {
      emit({ t: 'timeout', ts: ts(), scope: 'run' });
      requestCancel('timeout');
    });
    quota = watchQuota([paths.dir, paths.tmp], header.diskQuotaBytes, opts.quotaCheckMs ?? 5000, () =>
      requestCancel('resource_quota'),
    );

    // ---- running: attempt 1 runs the authorized specs; later attempts re-run only retryable targets (RUN-005)
    const exec = header.execution;
    const maxAttempts = exec && opts.hooks.attempts ? exec.maxAttempts : 1;
    let targets = exec?.targets ?? [];
    let crashed = false;
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      const specs = attemptNo === 1 ? header.specs : opts.hooks.attempts!.buildSpecs(header, attemptNo, targets);
      if (specs.length === 0) break;
      const attemptDir = paths.attemptDir(attemptNo);
      fs.mkdirSync(path.join(attemptDir, 'runner'), { recursive: true, mode: 0o700 });
      atomicWriteJson(path.join(attemptDir, 'spec.json'), specs);
      emit({ t: 'attempt.start', ts: ts(), attemptNo, specDigests: specs.map((s) => digest(s)) });
      const attemptProcesses: { exitCode?: number; signal?: string }[] = [];
      let current: ProcessIdentity | undefined;
      for (const [index, spec] of specs.entries()) {
        if (cancelReason) break;
        const ctx = opts.hooks.spawnContext({
          header,
          attemptNo,
          index,
          stdoutPath: path.join(attemptDir, `stdout-${index}.log`),
          stderrPath: path.join(attemptDir, `stderr-${index}.log`),
        });
        let spawned: Awaited<ReturnType<typeof spawnSpec>> | undefined;
        try {
          spawned = ctx ? await spawnSpec(spec, { ...ctx, port }) : undefined;
        } catch {
          spawned = undefined;
        }
        if (!spawned?.ok) {
          // Policy changed between dry run and spawn, or the spawn itself failed.
          crashed = true;
          break;
        }
        const p = spawned.process;
        current = p.identity;
        emit({
          t: 'process.start',
          ts: ts(),
          pid: p.identity.pid,
          pgid: p.identity.pgid,
          startTime: p.identity.startTime,
          executable: p.identity.executable,
          role: 'runner',
        });
        const exit = await Promise.race([p.exited, cancelled.then(() => undefined)]);
        if (!exit) break;
        current = undefined;
        emit({
          t: 'process.exit',
          ts: ts(),
          pid: p.identity.pid,
          ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
          ...(exit.signal ? { signal: exit.signal } : {}),
        });
        const rec = {
          ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
          ...(exit.signal ? { signal: exit.signal } : {}),
        };
        attemptProcesses.push(rec);
        processes.push({ pid: p.identity.pid, ...rec });
      }

      if (cancelReason) await cancelSequence(current);
      const parsed =
        exec && opts.hooks.attempts && !crashed
          ? parseAttempt(attemptNo, targets, attemptProcesses, cancelReason !== undefined)
          : undefined;
      emit({ t: 'attempt.end', ts: ts(), attemptNo, summary: parsed ? countOutcomes(parsed.results) : {} });
      if (cancelReason) return finish({ processes });
      if (crashed || !parsed || !exec) break;
      targets = selectRetryTargets(parsed.results, targets, exec.retryOn);
      if (targets.length === 0) break;
    }
    if (crashed) {
      move({ type: 'runner_crashed' });
      return finish({ processes });
    }
    move({ type: 'attempts_finished' });
    // Evidence ingestion (EVD-*) and analysis (ANL-*) run in the collecting and analyzing states.
    if (opts.hooks.collect) {
      try {
        await opts.hooks.collect(header);
      } catch (e) {
        fs.appendFileSync(paths.log, `${ts()} evidence collection failed: ${(e as Error).message}\n`);
        move({ type: 'storage_error' });
        return finish({ processes });
      }
    }
    move({ type: 'evidence_collected' });
    move({ type: 'analysis_done' });
    return finish({ processes });
  } catch (e) {
    // Unexpected supervisor fault: record what we can. `internal` is reachable only from analyzing; elsewhere the
    // server's reconciliation reports supervisor_lost from the missing terminal record.
    fs.appendFileSync(paths.log, `${ts()} supervisor fault: ${(e as Error).message}\n`);
    throw e;
  } finally {
    clearInterval(heartbeat);
    clearInterval(control);
    runTimer?.cancel();
    quota?.stop();
    if (opts.listenSignals) process.off('SIGTERM', onSigterm);
  }

  /** Parses one attempt through the adapter hooks and records `attempts/<n>/results.json`. */
  function parseAttempt(
    attemptNo: number,
    targets: readonly TestTarget[],
    attemptProcesses: readonly { exitCode?: number; signal?: string }[],
    interrupted: boolean,
  ): AttemptParse | undefined {
    try {
      const parsed = opts.hooks.attempts!.parseAttempt({
        header: header!,
        runDir: paths.dir,
        attemptNo,
        targets,
        processes: attemptProcesses,
        interrupted,
      });
      atomicWriteJson(
        path.join(paths.attemptDir(attemptNo), 'results.json'),
        AttemptResultsFile.parse({
          attemptNo,
          targetIds: targets.map((x) => x.id),
          interrupted,
          ...(parsed.protocol ? { protocol: parsed.protocol.slice(0, 64) } : {}),
          results: parsed.results,
          diagnostics: parsed.diagnostics.slice(0, 100),
        }),
      );
      return parsed;
    } catch (e) {
      fs.appendFileSync(paths.log, `${ts()} parsing attempt ${attemptNo} failed: ${(e as Error).message}\n`);
      return undefined;
    }
  }

  /** cancelling → (cancelled | timed_out | cancel_pending → … ) with identity-checked termination. */
  async function cancelSequence(id: ProcessIdentity | undefined): Promise<void> {
    move({ type: 'cancel_requested', reason: cancelReason! });
    if (!id) {
      emit({ t: 'cancel', ts: ts(), stage: 'confirmed' });
      move({ type: 'termination_confirmed' });
      return;
    }
    const res = await terminateGroup(id, {
      graceMs: header!.graceMs,
      port,
      onStage: (stage, s) => emit({ t: 'cancel', ts: ts(), stage, ...(s ? { survivors: [...s] } : {}) }),
    });
    if (res.outcome !== 'survivors') {
      // already_gone / identity_mismatch: our child had exited; nothing attributable remains.
      if (res.outcome !== 'confirmed') emit({ t: 'cancel', ts: ts(), stage: 'confirmed' });
      move({ type: 'termination_confirmed' });
      return;
    }
    move({ type: 'survivors_after_kill' });
    survivors = [...res.survivors];
    const deadline = Date.now() + header!.cancelVerifyWindowMs;
    for (let backoff = 100; Date.now() < deadline; backoff = Math.min(backoff * 2, 30_000)) {
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
      if (verifyGone(id, port)) {
        survivors = undefined;
        emit({ t: 'cancel', ts: ts(), stage: 'confirmed' });
        move({ type: 'survivors_gone' });
        return;
      }
    }
    move({ type: 'verification_window_exceeded' });
  }

  function finish(extra: { processes: TerminalRecord['processes'] }): TerminalRecord {
    const record: TerminalRecord = {
      runId: opts.runId,
      state: status.state,
      ...(status.cancelReason ? { cancelReason: status.cancelReason } : {}),
      ...(status.infraReason ? { infraReason: status.infraReason } : {}),
      ...(survivors ? { survivors } : {}),
      processes: extra.processes,
      endedAt: ts(),
    };
    emit({
      t: 'terminal',
      ts: ts(),
      state: status.state,
      ...(status.infraReason ? { infraReason: status.infraReason } : {}),
    });
    atomicWriteJson(paths.terminal, record);
    // Per-run scratch (children's HOME/TMPDIR) is removed at the terminal state (data model §On-disk layout).
    fs.rmSync(paths.tmp, { recursive: true, force: true });
    return record;
  }
}

/** Validates every spec against current policy before anything runs; false denies the dispatch. */
function dryRun(header: RunHeader, hooks: SupervisorHooks, paths: ReturnType<typeof runPaths>): boolean {
  return header.specs.every((spec: ExecutionSpec, index) => {
    const ctx = hooks.spawnContext({
      header,
      attemptNo: 1,
      index,
      stdoutPath: path.join(paths.attemptDir(1), `stdout-${index}.log`),
      stderrPath: path.join(paths.attemptDir(1), `stderr-${index}.log`),
    });
    return ctx !== undefined && validateSpec(spec, ctx).ok;
  });
}
