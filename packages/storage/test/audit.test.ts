import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { AuditDataError, verifyAuditChain, type AuditAppend } from '@autotest/core';
import { dataRootPaths, verifyAuditFiles } from '@autotest/storage';
import { freshRoot } from './helpers.ts';

const ev = (ts: string, i: number): AuditAppend => ({
  ts,
  actor: 'server',
  kind: 'tool.call',
  subjectRefs: [],
  data: { tool: 'get_pr_context', toolCallId: `c${i}` },
});

describe('OBS-002 audit log', () => {
  it('one chain spans monthly files; files are 0600; the file-only verifier agrees', async () => {
    const { root, open } = freshRoot();
    const audit = open().stores.audit;
    await audit.append(ev('2026-09-30T23:59:59Z', 0));
    await audit.append(ev('2026-10-01T00:00:00Z', 1));
    await audit.append(ev('2026-10-02T00:00:00Z', 2));
    const p = dataRootPaths(root);
    const sep = fs.readFileSync(p.auditFile('2026-09'), 'utf8').trim();
    const oct = fs.readFileSync(p.auditFile('2026-10'), 'utf8').trim().split('\n');
    expect(JSON.parse(oct[0]!).prevHash).toBe(JSON.parse(sep).hash);
    expect(fs.statSync(p.auditFile('2026-10')).mode & 0o777).toBe(0o600);
    expect(verifyAuditFiles(root)).toEqual({ ok: true, events: 3, files: 2 });
    expect(verifyAuditChain(await audit.readAll())).toBe(-1);
  });

  it('tampering with any line is detected at that line', async () => {
    const { root, open } = freshRoot();
    const audit = open().stores.audit;
    for (let i = 0; i < 5; i++) await audit.append(ev('2026-10-23T00:00:00Z', i));
    const file = dataRootPaths(root).auditFile('2026-10');
    const pristine = fs.readFileSync(file, 'utf8');
    for (let line = 1; line <= 5; line++) {
      const lines = pristine.trimEnd().split('\n');
      lines[line - 1] = lines[line - 1]!.replace(`"toolCallId":"c${line - 1}"`, '"toolCallId":"forged"');
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      expect(verifyAuditFiles(root)).toMatchObject({
        ok: false,
        file: '2026-10.ndjson',
        line,
        problem: 'hash_mismatch',
      });
    }
    const deleted = pristine.trimEnd().split('\n');
    deleted.splice(2, 1);
    fs.writeFileSync(file, `${deleted.join('\n')}\n`);
    expect(verifyAuditFiles(root)).toMatchObject({ ok: false, line: 3, problem: 'seq_gap' });
    fs.writeFileSync(file, `${pristine}{"broken`);
    expect(verifyAuditFiles(root)).toMatchObject({ ok: false, line: 6, problem: 'unparsable' });
  });

  it('appends from concurrent writers are serialized into one valid chain', async () => {
    const { root, open } = freshRoot();
    open().sql.close();
    const counts = await Promise.all(
      ['a', 'b', 'c'].map(
        (tag) =>
          new Promise<number>((resolve, reject) => {
            const w = new Worker(new URL('./workers/auditor.ts', import.meta.url), {
              workerData: { root, n: 100, tag },
            });
            w.once('message', resolve);
            w.once('error', reject);
          }),
      ),
    );
    expect(counts).toEqual([100, 100, 100]);
    expect(verifyAuditFiles(root)).toEqual({ ok: true, events: 300, files: 1 });
  });

  it('recovers the chain head from the files when the index is empty', async () => {
    const { root, open } = freshRoot();
    const { sql, stores } = open();
    await stores.audit.append(ev('2026-10-23T00:00:00Z', 0));
    await stores.audit.append(ev('2026-10-23T00:00:00Z', 1));
    sql.exec('DELETE FROM audit_index');
    const third = await stores.audit.append(ev('2026-10-23T00:00:00Z', 2));
    expect(third.seq).toBe(2);
    expect(verifyAuditFiles(root)).toEqual({ ok: true, events: 3, files: 1 });
  });

  it('an append whose index write fails leaves no line behind; the chain continues valid', async () => {
    const { root, open } = freshRoot();
    const { sql, stores } = open();
    await stores.audit.append(ev('2026-10-23T00:00:00Z', 0));
    sql.exec("CREATE TRIGGER t_fail BEFORE INSERT ON audit_index BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(stores.audit.append(ev('2026-10-23T00:00:00Z', 1))).rejects.toThrow(/disk full/);
    sql.exec('DROP TRIGGER t_fail');
    await stores.audit.append(ev('2026-10-23T00:00:00Z', 2));
    expect(verifyAuditFiles(root)).toEqual({ ok: true, events: 2, files: 1 });
  });

  it('rejects audit data that carries raw content', async () => {
    const { stores } = freshRoot().open();
    await expect(
      stores.audit.append({ ...ev('2026-10-23T00:00:00Z', 0), data: { tool: 'x', toolCallId: 'y', body: 'a\nb' } }),
    ).rejects.toBeInstanceOf(AuditDataError);
  });
});
