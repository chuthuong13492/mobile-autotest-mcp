// DISC-006: capture `flutter test --file-reporter json:` corpora per scenario for a given Flutter binary.
// Usage: node capture.mjs <flutterBin> <outDir>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const [flutter, outDirArg] = process.argv.slice(2); const outDir = path.resolve(outDirArg);
const app = new URL('./scratch_app/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });
const ver = JSON.parse(spawnSync(flutter, ['--version', '--machine'], { encoding: 'utf8' }).stdout);
const help = spawnSync(flutter, ['test', '--help', '--verbose'], { encoding: 'utf8' }).stdout;
const pubHelp = spawnSync(flutter, ['pub', 'get', '--help'], { encoding: 'utf8' }).stdout;
const flags = Object.fromEntries(['--no-pub', '--file-reporter', '--plain-name', '--coverage-path', '--reporter', '--timeout', '--total-shards', '--machine', '--update-goldens'].map(f => [f, help.includes(f)]));
flags['pub get --enforce-lockfile'] = pubHelp.includes('--enforce-lockfile');
const scenarios = [
  ['pass', ['corpus_tests/pass_test.dart']], ['fail', ['corpus_tests/fail_test.dart']], ['error', ['corpus_tests/error_test.dart']],
  ['skip', ['corpus_tests/skip_test.dart']], ['load_error', ['corpus_tests/load_error_test.dart']],
  ['timeout', ['--timeout', '3s', 'corpus_tests/timeout_test.dart']], ['plain_name', ['--plain-name', 'unit pass', 'corpus_tests/pass_test.dart']],
];
const summary = { flutterVersion: ver.frameworkVersion, dartSdkVersion: ver.dartSdkVersion, flags, scenarios: {} };
const summarize = (file) => { if (!fs.existsSync(file)) return { file: null };
  const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { malformed: true }; } });
  const start = ev.find(e => e.type === 'start'); const done = ev.find(e => e.type === 'done');
  const testsDone = ev.filter(e => e.type === 'testDone' && !e.hidden).map(e => ({ result: e.result, skipped: e.skipped }));
  return { events: ev.length, protocolVersion: start?.protocolVersion ?? null, done: done ? { success: done.success } : null, testsDone, errorEvents: ev.filter(e => e.type === 'error').length, types: [...new Set(ev.map(e => e.type))] }; };
for (const [name, args] of scenarios) {
  const file = path.join(outDir, `${name}.jsonl`);
  const r = spawnSync(flutter, ['test', '--no-pub', '--file-reporter', `json:${file}`, '--reporter', 'expanded', ...args], { cwd: app, encoding: 'utf8', timeout: 180000 });
  summary.scenarios[name] = { exitCode: r.status, ...summarize(file) };
}
// interrupted: SIGTERM after 8s while slow test runs
const ifile = path.join(outDir, 'interrupted.jsonl');
await new Promise(res => { const ch = spawn(flutter, ['test', '--no-pub', '--file-reporter', `json:${ifile}`, 'corpus_tests/slow_test.dart'], { cwd: app, detached: true, stdio: 'ignore' });
  setTimeout(() => { try { process.kill(-ch.pid, 'SIGTERM'); } catch {} }, 8000); ch.on('exit', (code, sig) => { summary.scenarios.interrupted = { exitCode: code, signal: sig, ...summarize(ifile) }; res(); }); });
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
