import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkIdentity,
  identify,
  nodeExecPort,
  RUN_MARKER_ENV,
  spawnSpec,
  terminateGroup,
  truncationMarker,
} from '@autotest/exec';
import { fixture, spec } from './helpers.ts';

const port = nodeExecPort();

describe('EXE-001 spawnSpec', () => {
  const f = fixture();

  it('passes shell metacharacters literally (no shell)', async () => {
    const evil = 'x; touch /tmp/autotest-pwned $(id) `id` | cat && echo "q" > out';
    const r = await spawnSpec(
      spec('echo-args', [
        { kind: 'flag', name: '--name', value: evil, inline: true },
        { kind: 'workspacePath', rel: 'test/a_test.dart' },
      ]),
      f.ctx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const exit = await r.process.exited;
    expect(exit.exitCode).toBe(0);
    const lines = fs
      .readFileSync(f.ctx().stdoutPath.replace(/stdout-\d+/, 'stdout-1'), 'utf8')
      .trimEnd()
      .split('\n');
    expect(lines).toEqual([
      'test',
      '--no-pub',
      '--plain-name',
      'echo-args',
      `--name=${evil}`,
      `${f.ws}/test/a_test.dart`,
    ]);
    expect(fs.existsSync('/tmp/autotest-pwned')).toBe(false);
  });

  it('refuses a spec that fails policy, without starting anything', async () => {
    const bad = { ...spec('echo-args'), args: [{ kind: 'word' as const, value: 'run' }] };
    const r = await spawnSpec(bad, f.ctx());
    expect(r).toEqual({ ok: false, denials: [{ code: 'unknown_form', detail: 'flutter' }] });
    const forbidden = await spawnSpec(spec('echo-args', [{ kind: 'flag', name: '--update-goldens' }]), f.ctx());
    expect(forbidden.ok).toBe(false);
    const envDenied = await spawnSpec({ ...spec('echo-args'), envNeeds: ['GITHUB_TOKEN'] }, f.ctx());
    expect(envDenied).toEqual({ ok: false, denials: [{ code: 'env_not_allowed', detail: 'GITHUB_TOKEN' }] });
  });

  it('builds a minimal environment with the run marker and run-scoped HOME/TMPDIR', async () => {
    const c = f.ctx();
    const r = await spawnSpec(spec('env'), c);
    if (!r.ok) throw new Error('denied');
    await r.process.exited;
    const env = Object.fromEntries(
      fs
        .readFileSync(c.stdoutPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(env[RUN_MARKER_ENV]).toBe('run_01JCAAAAAAAAAAAAAAAAAAAAAA');
    expect(env['HOME']).toBe(c.home);
    expect(env['TMPDIR']).toBe(c.tmpDir);
    expect(env['JAVA_HOME']).toBe('/opt/jdk');
    expect(env['CANARY_PARENT']).toBeUndefined();
    expect(env['PATH']?.startsWith(`${f.flutter.replace(/\/flutter$/, '')}:`)).toBe(true);
    expect(env['PATH']).not.toContain('/evil');
  });

  it('records an identity with the OS start time and its own process group', async () => {
    const r = await spawnSpec(spec('sleep'), f.ctx());
    if (!r.ok) throw new Error('denied');
    const id = r.process.identity;
    expect(id.pgid).toBe(id.pid);
    expect(id.startTime).toMatch(/^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
    expect(identify(port, id.pid)?.startTime).toBe(id.startTime);
    expect(checkIdentity(port, id)).toBe('match');
    expect(checkIdentity(port, { ...id, startTime: 'Thu Jan  1 00:00:00 1970' })).toBe('mismatch');
    await terminateGroup(id, { graceMs: 2000 });
    await r.process.exited;
    expect(checkIdentity(port, id)).toBe('gone');
  });

  it('caps output and writes a single truncation marker; files are 0600', async () => {
    const c = f.ctx({ outputCapBytes: 1000 });
    const r = await spawnSpec(spec('flood'), c);
    if (!r.ok) throw new Error('denied');
    const exit = await r.process.exited;
    expect(exit.stdout).toMatchObject({ bytesWritten: 1000, bytesSeen: 300000, truncated: true });
    const text = fs.readFileSync(c.stdoutPath, 'utf8');
    expect(text.endsWith(truncationMarker(1000))).toBe(true);
    expect(fs.statSync(c.stdoutPath).mode & 0o777).toBe(0o600);
  });
});
