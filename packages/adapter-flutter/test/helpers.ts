/** In-memory workspace and reporter-event builders (adapter tests may not touch the filesystem). */
import type { AdapterWorkspace, ProbePort, RunnerOutputs, TestTarget } from '@autotest/adapter-sdk';

function globToRe(glob: string): RegExp {
  const re = glob
    .split('**/')
    .map((part) =>
      part
        .replace(/[.+^$()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*'),
    )
    .join('(?:[^/]+/)*');
  return new RegExp(`^${re}$`);
}

/** A workspace over a path → text map; directories exist when any file lives under them. */
export function memoryWorkspace(files: Record<string, string>): AdapterWorkspace {
  return {
    readText: (rel, max = 1 << 20) => {
      const t = files[rel];
      if (t === undefined) throw new Error('not found');
      return { text: t.slice(0, max), sizeBytes: t.length, truncated: t.length > max, binary: false };
    },
    exists: (rel) => rel in files || Object.keys(files).some((f) => f.startsWith(`${rel}/`)),
    list: (globs, opts = {}) => {
      const inc = globs.map(globToRe);
      const exc = (opts.exclude ?? []).map(globToRe);
      const all = Object.keys(files)
        .filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)))
        .sort();
      const max = opts.maxFiles ?? 5000;
      return { files: all.slice(0, max), matched: all.length, truncated: all.length > max };
    },
  };
}

export const PUBSPEC = `name: demo
environment:
  sdk: ">=3.5.0 <4.0.0"
  flutter: 3.38.4

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
`;

export const probeReturning = (stdout: string): ProbePort => ({
  probe: async (kind) =>
    kind === 'flutter_version' ? { available: true, stdout, exitCode: 0 } : { available: false, reason: 'n/a' },
});

/** Reporter events for tests in one suite file, in the shape `flutter test --file-reporter json:` writes. */
export function reporter(
  suitePath: string,
  tests: readonly {
    readonly name: string;
    readonly result?: string;
    readonly skipped?: boolean;
    readonly hidden?: boolean;
    readonly error?: string;
    readonly isFailure?: boolean;
    readonly errorAfterDone?: string;
  }[],
  done: boolean | null | 'missing' = true,
): string {
  const ev: object[] = [
    { protocolVersion: '0.1.1', runnerVersion: null, pid: 1, type: 'start', time: 0 },
    { suite: { id: 0, platform: 'vm', path: `/abs/app/${suitePath}` }, type: 'suite', time: 0 },
  ];
  let id = 1;
  for (const t of tests) {
    const tid = id++;
    ev.push({ test: { id: tid, name: t.name, suiteID: 0, groupIDs: [] }, type: 'testStart', time: 10 });
    if (t.error) ev.push({ testID: tid, error: t.error, stackTrace: 'trace', isFailure: !!t.isFailure, type: 'error' });
    if (t.result !== undefined)
      ev.push({ testID: tid, result: t.result, skipped: !!t.skipped, hidden: !!t.hidden, type: 'testDone', time: 35 });
    if (t.errorAfterDone)
      ev.push({ testID: tid, error: t.errorAfterDone, stackTrace: '', isFailure: false, type: 'error' });
  }
  if (done !== 'missing') ev.push({ success: done, type: 'done', time: 50 });
  return `${ev.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

export function outputs(
  targets: readonly TestTarget[],
  files: Record<string, string | undefined>,
  interrupted = false,
  attemptNo = 1,
): RunnerOutputs {
  return { attemptNo, targets, files, processes: [{ exitCode: 1 }], interrupted };
}
