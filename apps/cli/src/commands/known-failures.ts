/**
 * `autotest known-failures` (ANL-002; FR-038): the user-owned registry of failures that already exist on the base
 * branch. An entry names one test target, a test-name pattern (`*` matches anything), a reason, a link to the
 * evidence and an expiry (at most one year ahead). A matching failure is analyzed as `pre_existing/known_failure`
 * until the entry expires. Adding and removing entries is audited; the agent has no tool for either.
 */
import { targetId, type KnownFailure } from '@autotest/core';
import type { CliContext } from '../context.ts';
import type { Io } from '../io.ts';

const YEAR_MS = 366 * 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface AddFlags {
  readonly target: string;
  readonly adapter: string;
  readonly name: string;
  readonly reason: string;
  readonly link: string;
  readonly expires: string;
}

/** Parses `add` flags; undefined when a flag is missing, repeated or unknown. */
export function parseAddFlags(args: readonly string[]): AddFlags | undefined {
  const known = new Set(['--target', '--adapter', '--name', '--reason', '--link', '--expires']);
  const v = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [k, val] = [args[i]!, args[i + 1]];
    if (!known.has(k) || val === undefined || v.has(k)) return undefined;
    v.set(k, val);
  }
  const [target, name, reason, link, expires] = ['--target', '--name', '--reason', '--link', '--expires'].map((k) =>
    v.get(k),
  );
  if (!target || !name || !reason || !link || !expires) return undefined;
  return { target, adapter: v.get('--adapter') ?? 'flutter', name, reason, link, expires };
}

function resolveTarget(f: AddFlags): string | undefined {
  if (/^TT-[a-z0-9-]+-[0-9a-f]{12}$/.test(f.target)) return f.target;
  try {
    return targetId(f.adapter, f.target);
  } catch {
    return undefined;
  }
}

export async function addKnownFailure(ctx: CliContext, io: Io, f: AddFlags): Promise<number> {
  const now = ctx.ports.clock.now();
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(f.expires) ? new Date(`${f.expires}T00:00:00Z`) : new Date(NaN);
  if (Number.isNaN(expires.getTime()) || expires <= now || expires.getTime() - now.getTime() > YEAR_MS) {
    io.err('--expires must be a date (YYYY-MM-DD) in the future and at most one year ahead.');
    return 2;
  }
  const target = resolveTarget(f);
  if (!target) {
    io.err('--target must be a test target id (TT-…) or a test file path relative to the workspace.');
    return 2;
  }
  let entry: KnownFailure;
  try {
    entry = await ctx.ports.knownFailures.add({
      targetId: target,
      namePattern: f.name.slice(0, 500),
      reason: f.reason.slice(0, 500),
      addedBy: ctx.osUser,
      expiresAt: iso(expires),
      evidenceLink: f.link.slice(0, 1024),
    });
  } catch (e) {
    io.err(`Cannot add the entry: ${(e as Error).message}`);
    return 1;
  }
  await ctx.ports.audit.append({
    ts: iso(now),
    actor: 'cli',
    kind: 'known_failure.added',
    subjectRefs: [entry.id],
    data: { knownFailureId: entry.id, targetId: entry.targetId, expiresAt: entry.expiresAt },
  });
  io.out(`Added ${entry.id} for ${entry.targetId}, expires ${entry.expiresAt}.`);
  return 0;
}

export async function listKnownFailures(ctx: CliContext, io: Io): Promise<number> {
  const now = ctx.ports.clock.now().getTime();
  const all = await ctx.ports.knownFailures.list();
  io.out(`Known failures (${all.length}):`);
  for (const k of all)
    io.out(
      `  ${k.id}  ${Date.parse(k.expiresAt) > now ? 'active ' : 'expired'}  ${k.targetId}  "${k.namePattern}"  until ${k.expiresAt}  ${k.reason}`,
    );
  return 0;
}

export async function removeKnownFailure(ctx: CliContext, io: Io, id: string): Promise<number> {
  if (!(await ctx.ports.knownFailures.remove(id))) {
    io.err(`No known failure ${id}.`);
    return 1;
  }
  await ctx.ports.audit.append({
    ts: iso(ctx.ports.clock.now()),
    actor: 'cli',
    kind: 'known_failure.removed',
    subjectRefs: [id],
    data: { knownFailureId: id },
  });
  io.out(`Removed ${id}.`);
  return 0;
}
