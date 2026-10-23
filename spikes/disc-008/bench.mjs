// DISC-008 throwaway spike: evaluate node:sqlite for the storage port (WAL, busy_timeout, tx, prepared stmts, 2-process concurrency).
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const role = process.argv[2];
const dbPath = process.argv[3] || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disc008-')), 'test.db');
const open = () => { const db = new DatabaseSync(dbPath); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); return db; };
if (role === 'writer') {
  const db = open(); const ins = db.prepare('INSERT INTO ev(src, n) VALUES (?, ?)'); let busy = 0;
  for (let i = 0; i < 2000; i++) { try { db.exec('BEGIN IMMEDIATE'); ins.run(process.pid, i); db.exec('COMMIT'); } catch (e) { busy++; try { db.exec('ROLLBACK'); } catch {} } }
  db.close(); process.send({ pid: process.pid, busy }); process.exit(0);
}
const out = { node: process.version };
const db = open();
out.journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
out.busyTimeout = Object.values(db.prepare('PRAGMA busy_timeout').get())[0];
out.fk = Object.values(db.prepare('PRAGMA foreign_keys').get())[0];
out.sqliteVersion = db.prepare('select sqlite_version() v').get().v;
db.exec('CREATE TABLE ev(id INTEGER PRIMARY KEY, src INTEGER NOT NULL, n INTEGER NOT NULL); CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(pid TEXT REFERENCES p(id));');
try { db.exec("INSERT INTO c VALUES ('missing')"); out.fkEnforced = false; } catch { out.fkEnforced = true; }
// transaction rollback
db.exec('BEGIN'); db.prepare('INSERT INTO p VALUES (?)').run('a'); db.exec('ROLLBACK'); out.rollbackWorks = db.prepare('select count(*) c from p').get().c === 0;
// single-process insert throughput
const ins = db.prepare('INSERT INTO ev(src, n) VALUES (?, ?)'); let t = performance.now();
db.exec('BEGIN'); for (let i = 0; i < 50000; i++) ins.run(0, i); db.exec('COMMIT'); out.insert50kTxMs = Math.round(performance.now() - t);
db.exec('DELETE FROM ev'); db.close();
// two-process concurrency
t = performance.now();
const results = await Promise.all([0, 1].map(() => new Promise(res => { const ch = fork(new URL(import.meta.url).pathname, ['writer', dbPath], { stdio: 'pipe' }); ch.on('message', res); })));
out.concurrentMs = Math.round(performance.now() - t); out.writerBusyErrors = results.map(r => r.busy);
const db2 = open(); out.concurrentRows = db2.prepare('select count(*) c from ev').get().c; out.integrity = db2.prepare('PRAGMA integrity_check').get().integrity_check; db2.close();
fs.chmodSync(dbPath, 0o600); out.mode = (fs.statSync(dbPath).mode & 0o777).toString(8);
console.log(JSON.stringify(out));
