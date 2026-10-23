import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { untrusted } from '@autotest/core';
import { createServerLogger, fileSink, guardConsole, serverLogTransform } from '@autotest/mcp-server';

const rep = (c: string, n: number) => c.repeat(n);
const KNOWN = `known-${rep('Pw9x', 5)}`;
const GH = `gh${'p'}_${rep('aB3', 12)}`;

afterEach(() => vi.restoreAllMocks());

describe('OBS-001 server logging', () => {
  it('canary secrets, credential patterns and PII never reach stderr, and nothing goes to stdout', () => {
    const out = vi.spyOn(process.stdout, 'write');
    const lines: string[] = [];
    const log = createServerLogger({
      knownValues: [KNOWN],
      piiSalt: 'salt',
      env: { AUTOTEST_LOG_LEVEL: 'debug' },
      stderr: { write: (s: string) => lines.push(s) },
    });
    log.error('spawn.failed', {
      data: {
        stderr: `using ${KNOWN} and ${GH}`,
        url: 'https://u:hunter22@ghe.example.com/x',
        contact: 'jane.doe@example.com',
      },
    });
    log.debug('pr.parsed', { data: { body: untrusted(`password: hunter22 ${KNOWN}`) } });
    const text = lines.join('');
    for (const leaked of [KNOWN, GH, 'hunter22', 'jane.doe']) expect(text).not.toContain(leaked);
    expect(text).toContain('[REDACTED:known_value]');
    expect(text).toMatch(/pii:[0-9a-f]{12}/);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[0]!).sessionId).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out).not.toHaveBeenCalled();
  });

  it('the file sink writes 0600 files in a 0700 directory and caps each day', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-logs-')), 'logs');
    const sink = fileSink(dir, 200, () => new Date('2026-10-23T01:00:00Z'));
    for (let i = 0; i < 10; i++) sink.write(`${JSON.stringify({ i, pad: 'x'.repeat(40) })}\n`);
    const file = path.join(dir, 'server-2026-10-23.ndjson');
    const content = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(content.at(-1)).toContain('log_file_capped');
    expect(content.length).toBeLessThan(10);
  });

  it('guardConsole routes console output to stderr through redaction, never to stdout', () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err: string[] = [];
    const restore = guardConsole(serverLogTransform({ knownValues: [KNOWN], piiSalt: 's' }), {
      write: (s: string) => err.push(s),
    });
    try {
      console.log('dependency says %s', KNOWN);
      console.info({ token: GH });
    } finally {
      restore();
    }
    expect(out).not.toHaveBeenCalled();
    expect(err.join('')).not.toContain(KNOWN);
    expect(err.join('')).not.toContain(GH);
    expect(err).toHaveLength(2);
  });
});
