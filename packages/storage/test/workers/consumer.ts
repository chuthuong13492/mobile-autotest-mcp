/** Worker: tries to consume one approval `attempts` times through its own connection; posts the success count. */
import { parentPort, workerData } from 'node:worker_threads';
import { openDataRoot } from '@autotest/storage';

const { root, id, attempts } = workerData as { root: string; id: string; attempts: number };
const { sql, stores } = openDataRoot(root);
let ok = 0;
for (let i = 0; i < attempts; i++) {
  try {
    await stores.approvals.consume(id, new Date('2026-10-23T01:00:00Z'));
    ok++;
  } catch {
    // not_usable once exhausted
  }
}
sql.close();
parentPort!.postMessage(ok);
