/** Worker: writes `n` single-row IMMEDIATE transactions through its own connection; posts the error count. */
import { parentPort, workerData } from 'node:worker_threads';
import { openSqlite } from '@autotest/storage';

const { db, src, n } = workerData as { db: string; src: number; n: number };
const sql = openSqlite(db);
let errors = 0;
for (let i = 0; i < n; i++) {
  try {
    sql.transaction(() => sql.run('INSERT INTO ev (src, n) VALUES (?, ?)', src, i));
  } catch {
    errors++;
  }
}
sql.close();
parentPort!.postMessage(errors);
