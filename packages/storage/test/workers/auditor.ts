/** Worker: appends `n` audit events through its own connection; posts the number appended. */
import { parentPort, workerData } from 'node:worker_threads';
import { openDataRoot } from '@autotest/storage';

const { root, n, tag } = workerData as { root: string; n: number; tag: string };
const { sql, stores } = openDataRoot(root);
let ok = 0;
for (let i = 0; i < n; i++) {
  await stores.audit.append({
    ts: '2026-10-23T00:00:00Z',
    actor: 'server',
    kind: 'tool.call',
    subjectRefs: [],
    data: { tool: tag, toolCallId: `${tag}-${i}` },
  });
  ok++;
}
sql.close();
parentPort!.postMessage(ok);
