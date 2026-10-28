import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicyConfig } from '@autotest/policy';
import { parseSetupFlags, run, serverEntryPath, workspaceId } from '@autotest/cli';
import { io } from './fixtures.ts';

function machine() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-setup-')));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(base, 'claude.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`, { mode: 0o755 });
  const sdk = path.join(base, 'flutter-sdk', 'bin');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  const app = path.join(base, 'My App');
  fs.mkdirSync(app);
  const data = path.join(base, '.autotest');
  return {
    base,
    app,
    data,
    log,
    flutter: path.join(sdk, 'flutter'),
    env: { env: { HOME: base, AUTOTEST_HOME: data, PATH: `${bin}:/usr/bin:/bin` } },
  };
}

describe('autotest setup', () => {
  it('parses flags strictly and derives readable workspace ids', () => {
    expect(parseSetupFlags(['--yes', '--workspace', '/a', '--workspace', '/b', '--flutter', '/f'])).toEqual({
      yes: true,
      workspaces: ['/a', '/b'],
      flutter: '/f',
      skipClaude: false,
    });
    expect(parseSetupFlags(['--workspace'])).toBeUndefined();
    expect(parseSetupFlags(['--rm-rf'])).toBeUndefined();
    expect(workspaceId('/x/My App!', new Set())).toBe('ws_my_app');
    expect(workspaceId('/y/my-app', new Set(['ws_my_app']))).toBe('ws_my_app_2');
  });

  it('configures the workspace and Flutter, registers the server with the absolute Node path, installs the Skill; re-running is idempotent', async () => {
    const m = machine();
    const t = io(false);
    expect(await run(['setup', '--yes', '--workspace', m.app, '--flutter', m.flutter], t.value, m.env)).toBe(0);
    const text = fs.readFileSync(path.join(m.data, 'config.yaml'), 'utf8');
    expect(text).toContain('# AutoTest user policy');
    const policy = loadPolicyConfig(text);
    if (!policy.ok) throw new Error(policy.error.error.message);
    expect(policy.policy.config.workspaces).toEqual([{ id: 'ws_my_app', path: m.app, readOnlyReference: false }]);
    // setup also allowlists a gh and a git it finds on PATH; the test PATH includes /usr/bin and /bin, which have gh on some
    // hosts (GitHub's Ubuntu runners) and not on others.
    const system = (name: string) => ['/usr/bin', '/bin'].map((d) => `${d}/${name}`).find((p) => fs.existsSync(p));
    const [systemGh, systemGit, systemXcrun, systemXcodebuild] = [
      system('gh'),
      system('git'),
      system('xcrun'),
      system('xcodebuild'),
    ];
    expect(policy.policy.config.executables).toEqual({
      flutter: { path: m.flutter },
      ...(systemGh ? { gh: { path: fs.realpathSync(systemGh) } } : {}),
      ...(systemGit ? { git: { path: fs.realpathSync(systemGit) } } : {}),
      ...(systemXcrun ? { xcrun: { path: fs.realpathSync(systemXcrun) } } : {}),
      ...(systemXcodebuild ? { xcodebuild: { path: fs.realpathSync(systemXcodebuild) } } : {}),
      // RN-002: the Node running setup runs a React Native project's own Jest and Detox.
      node: { path: fs.realpathSync(process.execPath) },
    });
    expect(fs.statSync(path.join(m.data, 'config.yaml')).mode & 0o777).toBe(0o600);
    const calls = fs.readFileSync(m.log, 'utf8').trim().split('\n');
    expect(calls).toEqual([
      'mcp remove --scope user autotest',
      `mcp add --scope user autotest -e AUTOTEST_HOME=${m.data} -- ${process.execPath} ${serverEntryPath()}`,
    ]);
    expect(fs.existsSync(serverEntryPath())).toBe(true);
    const skill = path.join(m.base, '.claude', 'skills', 'pr-mobile-autotest', 'SKILL.md');
    expect(fs.readFileSync(skill, 'utf8')).toMatch(/^name: pr-mobile-autotest$/m);
    expect(t.out.join('\n')).toContain('Bash(autotest approve*)');
    expect(fs.existsSync(path.join(m.base, '.claude', 'settings.json'))).toBe(false);

    expect(await run(['setup', '--yes', '--workspace', m.app, '--flutter', m.flutter], io(false).value, m.env)).toBe(0);
    const again = loadPolicyConfig(fs.readFileSync(path.join(m.data, 'config.yaml'), 'utf8'));
    expect(again.ok && again.policy.config.workspaces.length).toBe(1);
  });

  it('without the claude CLI prints the JSON to add; uninstall-claude removes the Skill and keeps the data root', async () => {
    const m = machine();
    const env = { env: { ...m.env.env, PATH: '/usr/bin:/bin' } };
    const t = io(false);
    expect(await run(['setup', '--yes'], t.value, env)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('Claude Code CLI not found on PATH');
    expect(text).toContain(`"command": "${process.execPath}"`);
    const u = io(false);
    expect(await run(['uninstall-claude'], u.value, m.env)).toBe(0);
    expect(fs.existsSync(path.join(m.base, '.claude', 'skills', 'pr-mobile-autotest'))).toBe(false);
    expect(fs.existsSync(path.join(m.data, 'config.yaml'))).toBe(true);
    expect(fs.readFileSync(m.log, 'utf8')).toContain('mcp remove --scope user autotest');
  });

  it('refuses a workspace that is not a directory and a relative flutter path', async () => {
    const m = machine();
    expect(await run(['setup', '--yes', '--workspace', path.join(m.base, 'nope')], io(false).value, m.env)).toBe(1);
    expect(await run(['setup', '--yes', '--flutter', 'flutter'], io(false).value, m.env)).toBe(1);
  });
});

describe('autotest setup and doctor with GitHub (gh)', () => {
  it('allowlists gh from PATH, enables publication on request, and doctor reports the gh login', async () => {
    const m = machine();
    const bin = path.join(m.base, 'bin');
    const ghLog = path.join(m.base, 'gh.log');
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\necho "$@" >> ${ghLog}\n[ "$1 $2" = "auth status" ] && exit \${GH_FAKE_STATUS:-0}\nexit 1\n`,
      { mode: 0o755 },
    );
    const t = io(false);
    expect(await run(['setup', '--yes', '--skip-claude', '--enable-publication'], t.value, m.env)).toBe(0);
    const policy = loadPolicyConfig(fs.readFileSync(path.join(m.data, 'config.yaml'), 'utf8'));
    if (!policy.ok) throw new Error(policy.error.error.message);
    expect(policy.policy.config.executables['gh']).toEqual({ path: fs.realpathSync(path.join(bin, 'gh')) });
    expect(policy.policy.config.github.publication).toEqual({
      enabled: true,
      mechanisms: ['comment', 'check_run', 'commit_status'],
    });
    const d = io(false);
    await run(['doctor'], d.value, m.env);
    expect(d.out.join('\n')).toMatch(/PASS {2}github\s+gh is logged in to github\.com/);
    expect(fs.readFileSync(ghLog, 'utf8')).toContain('auth status --hostname github.com');
    const notLogged = io(false);
    await run(['doctor'], notLogged.value, { env: { ...m.env.env, GH_FAKE_STATUS: '1' } });
    // The child only gets PATH/HOME/gh variables, so GH_FAKE_STATUS does not reach it: the login still reports PASS.
    expect(notLogged.out.join('\n')).toMatch(/github\s+gh is logged in/);
  });
});
