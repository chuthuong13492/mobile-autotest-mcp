/**
 * Executable registry and ExecutionSpec validation (POL-003; SR-001, SR-002, SR-014; ADR-0014; T-03, T-08).
 *
 * Logical executables map to configured absolute paths, pinned by realpath and an optional SHA-256 at load time;
 * PATH is never consulted. `validateSpec` renders typed argument tokens into argv only when they match one command
 * form of the executable's built-in argument schema, and resolves every path token inside the workspace or the run
 * directory. Denials name flags and reasons, never argument values.
 */
import path from 'node:path';
import type { ExecutionSpec } from '@autotest/contracts';
import { ARG_SCHEMAS, type ArgSchema, type CommandForm, type ExecClass, type FlagRule } from './argschemas/index.ts';
import type { PolicyConfig } from './config.ts';
import { checkPath, type FsPort } from './paths.ts';

export interface PinnedExecutable {
  readonly logical: string;
  readonly realPath: string;
  readonly sha256?: string;
}

export interface Registry {
  readonly executables: ReadonlyMap<string, PinnedExecutable>;
  /** Logical names whose path is missing or whose pinned hash does not match (doctor reports these). */
  readonly problems: readonly {
    readonly logical: string;
    readonly reason: 'missing' | 'not_a_file' | 'hash_mismatch';
  }[];
}

/** Resolves configured executables once. A hash mismatch or missing file leaves the executable unregistered. */
export function buildRegistry(fsp: FsPort, executables: PolicyConfig['executables']): Registry {
  const map = new Map<string, PinnedExecutable>();
  const problems: Registry['problems'][number][] = [];
  for (const [logical, entry] of Object.entries(executables)) {
    let realPath: string;
    try {
      realPath = fsp.realpath(entry.path);
    } catch {
      problems.push({ logical, reason: 'missing' });
      continue;
    }
    if (!fsp.lstat(realPath)?.isFile) {
      problems.push({ logical, reason: 'not_a_file' });
      continue;
    }
    if (entry.sha256 && fsp.sha256(realPath) !== entry.sha256) {
      problems.push({ logical, reason: 'hash_mismatch' });
      continue;
    }
    map.set(logical, { logical, realPath, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
  }
  return { executables: map, problems };
}

export type DenialCode =
  | 'unknown_executable'
  | 'unknown_form'
  | 'unknown_flag'
  | 'forbidden_flag'
  | 'bad_value'
  | 'missing_flag'
  | 'duplicate_flag'
  | 'unexpected_token'
  | 'path_denied'
  | 'cwd_denied'
  | 'gated'
  | 'class_not_allowed'
  | 'missing_positional';

export interface Denial {
  readonly code: DenialCode;
  /** A flag name, a token index or a schema id; never an argument value. */
  readonly detail: string;
}

export interface ValidationContext {
  readonly fs: FsPort;
  readonly registry: Registry;
  /** Canonical workspace root. */
  readonly workspaceRoot: string;
  /** Canonical run directory (outputs go here). */
  readonly runDir: string;
  readonly allowDependencyResolution: boolean;
  /** Classes this phase may run; defaults to all. */
  readonly allowedClasses?: readonly ExecClass[];
}

export type SpecValidation =
  | {
      readonly ok: true;
      readonly executablePath: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly formId: string;
      readonly class: ExecClass;
    }
  | { readonly ok: false; readonly denials: readonly Denial[] };

/** Validates a spec and renders argv. Every token must be accounted for by the matched form. */
export function validateSpec(spec: ExecutionSpec, ctx: ValidationContext): SpecValidation {
  const exe = ctx.registry.executables.get(spec.executable);
  const schema = ARG_SCHEMAS[spec.executable];
  if (!exe || !schema) return deny('unknown_executable', spec.executable);

  const cwd = checkPath(ctx.fs, ctx.workspaceRoot, spec.cwd, { mustExist: true });
  if (!cwd.ok || !ctx.fs.lstat(cwd.path)?.isDirectory)
    return deny('cwd_denied', cwd.ok ? 'not_a_directory' : cwd.reason);

  const form = matchForm(schema, spec);
  if (!form) return deny('unknown_form', `${schema.executable}`);
  if (form.gate === 'dependency_resolution' && !ctx.allowDependencyResolution) return deny('gated', form.id);
  if (ctx.allowedClasses && !ctx.allowedClasses.includes(form.class)) return deny('class_not_allowed', form.id);

  const denials: Denial[] = [];
  const argv: string[] = [];
  const lead = form.leading ?? [];
  for (const [i, rule] of lead.entries()) {
    const tok = spec.args[i];
    if (tok?.kind !== 'flag' || tok.name !== rule.name) {
      denials.push({ code: 'unexpected_token', detail: `#${i}` });
      continue;
    }
    const rendered = renderFlag(rule, tok, ctx);
    if ('code' in rendered) denials.push(rendered);
    else argv.push(...rendered.argv);
  }
  argv.push(...form.words);
  const seen = new Map<string, number>();
  let positional = 0;
  let next = 0;

  const skip = lead.length + form.words.length;
  for (const [i, tok] of spec.args.slice(skip).entries()) {
    const at = `#${i + skip}`;
    switch (tok.kind) {
      case 'word': {
        const p = form.positionals?.[next];
        if (p?.kind === 'word' && p.pattern.test(tok.value) && !tok.value.startsWith('-')) {
          argv.push(tok.value);
          next++;
        } else denials.push({ code: 'unexpected_token', detail: at });
        break;
      }
      case 'workspacePath': {
        if (
          !form.positionalPaths ||
          !form.positionalPaths.pattern.test(tok.rel) ||
          ++positional > form.positionalPaths.max
        ) {
          denials.push({ code: 'path_denied', detail: at });
          break;
        }
        const r = checkPath(ctx.fs, ctx.workspaceRoot, tok.rel, { mustExist: true });
        if (r.ok) argv.push(r.path);
        else denials.push({ code: 'path_denied', detail: `${at}:${r.reason}` });
        break;
      }
      case 'runPath': {
        const p = form.positionals?.[next];
        if (p?.kind !== 'runPath' || tok.prefix || !p.pattern.test(tok.rel)) {
          denials.push({ code: 'unexpected_token', detail: at });
          break;
        }
        next++;
        const r = checkPath(ctx.fs, ctx.runDir, tok.rel);
        if (r.ok && path.isAbsolute(r.path)) argv.push(r.path);
        else denials.push({ code: 'path_denied', detail: at });
        break;
      }
      case 'flag':
      case 'flagRunPath': {
        const rule = flagRule(schema, form, tok.name, denials);
        if (!rule) break;
        const count = (seen.get(rule.name) ?? 0) + 1;
        seen.set(rule.name, count);
        if (count > 1 && !rule.repeatable) {
          denials.push({ code: 'duplicate_flag', detail: rule.name });
          break;
        }
        const rendered = tok.kind === 'flag' ? renderFlag(rule, tok, ctx) : renderRunPathFlag(rule, tok, ctx);
        if ('code' in rendered) denials.push(rendered);
        else argv.push(...rendered.argv);
        break;
      }
    }
  }
  for (const req of form.requiredFlags) if (!seen.has(req)) denials.push({ code: 'missing_flag', detail: req });
  for (const [i, c] of (spec.collect ?? []).entries()) {
    const r = checkPath(ctx.fs, ctx.workspaceRoot, c.dir);
    if (!r.ok) denials.push({ code: 'path_denied', detail: `collect#${i}:${r.reason}` });
  }
  if (next < (form.positionals?.length ?? 0)) denials.push({ code: 'missing_positional', detail: `#${next}` });
  if (denials.length) return { ok: false, denials };
  return { ok: true, executablePath: exe.realPath, argv, cwd: cwd.path, formId: form.id, class: form.class };
}

const deny = (code: DenialCode, detail: string): SpecValidation => ({ ok: false, denials: [{ code, detail }] });

function matchForm(schema: ArgSchema, spec: ExecutionSpec): CommandForm | undefined {
  const leadWords = (skip: number) => {
    const out: string[] = [];
    for (const t of spec.args.slice(skip)) {
      if (t.kind !== 'word') break;
      out.push(t.value);
    }
    return out;
  };
  // The longest form whose words are exactly the leading words (after its leading flags); a form with positionals
  // may be followed by more words (its positional words, checked one by one afterwards).
  return [...schema.forms]
    .sort((a, b) => b.words.length - a.words.length)
    .find((f) => {
      const lead = leadWords(f.leading?.length ?? 0);
      return (
        (f.positionals ? f.words.length <= lead.length : f.words.length === lead.length) &&
        f.words.every((w, i) => w === lead[i])
      );
    });
}

function flagRule(schema: ArgSchema, form: CommandForm, name: string, denials: Denial[]): FlagRule | undefined {
  if (schema.forbiddenFlags.includes(name)) {
    denials.push({ code: 'forbidden_flag', detail: name });
    return undefined;
  }
  const rule = form.flags.find((f) => f.name === name);
  if (!rule) denials.push({ code: 'unknown_flag', detail: name });
  return rule;
}

function renderFlag(
  rule: FlagRule,
  tok: { name: string; value?: string | undefined; inline?: boolean | undefined },
  ctx: ValidationContext,
): { argv: string[] } | Denial {
  const v = rule.value;
  if (v.kind === 'none')
    return tok.value === undefined ? { argv: [rule.name] } : { code: 'bad_value', detail: rule.name };
  if (v.kind === 'runPath' || tok.value === undefined) return { code: 'bad_value', detail: rule.name };
  if (v.kind === 'workspacePath') {
    if (tok.inline || !v.pattern.test(tok.value)) return { code: 'bad_value', detail: rule.name };
    const r = checkPath(ctx.fs, ctx.workspaceRoot, tok.value, { mustExist: true });
    if (!r.ok || !ctx.fs.lstat(r.path)?.isFile) return { code: 'path_denied', detail: rule.name };
    return { argv: [rule.name, r.path] };
  }
  const ok = v.kind === 'enum' ? v.values.includes(tok.value) : v.pattern.test(tok.value);
  if (!ok) return { code: 'bad_value', detail: rule.name };
  // A separate value that starts with '-' could be parsed as another flag; it must be inline.
  if (tok.inline) return { argv: [`${rule.name}=${tok.value}`] };
  if (tok.value.startsWith('-')) return { code: 'bad_value', detail: rule.name };
  return { argv: [rule.name, tok.value] };
}

function renderRunPathFlag(
  rule: FlagRule,
  tok: { rel: string; prefix?: string | undefined },
  ctx: ValidationContext,
): { argv: string[] } | Denial {
  if (rule.value.kind !== 'runPath' || (tok.prefix ?? '') !== rule.value.prefix)
    return { code: 'bad_value', detail: rule.name };
  const r = checkPath(ctx.fs, ctx.runDir, tok.rel);
  if (!r.ok) return { code: 'path_denied', detail: `${rule.name}:${r.reason}` };
  if (!path.isAbsolute(r.path)) return { code: 'path_denied', detail: rule.name };
  return { argv: [rule.name, `${rule.value.prefix}${r.path}`] };
}
