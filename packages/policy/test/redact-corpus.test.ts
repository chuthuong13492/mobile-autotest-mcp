/** POL-005 acceptance: false-positive rate on the captured Flutter reporter fixtures, and throughput. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '@autotest/policy';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/flutter-json');
const files = fs
  .readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && /\.(jsonl|json)$/.test(d.name))
  .map((d) => path.join(d.parentPath, d.name));

describe('POL-005 corpus measurements', () => {
  it('has zero findings (false positives) on the scrubbed Flutter fixture logs', () => {
    const r = createRedactor();
    let lines = 0;
    const findings: Record<string, number> = {};
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      lines += text.split('\n').length;
      const out = r.redact(text);
      for (const [k, v] of Object.entries(out.findings)) findings[k] = (findings[k] ?? 0) + (v ?? 0);
      expect(out.text === text || Object.keys(out.findings).length > 0).toBe(true);
    }
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(lines).toBeGreaterThan(100);
    expect(findings).toEqual({});
  });

  it('redacts at a usable throughput (informational; asserts only a generous floor)', () => {
    const r = createRedactor({ knownValues: ['synthetic-known-value'] });
    const sample = fs.readFileSync(files[0]!, 'utf8');
    const big = sample.repeat(Math.ceil((4 * 1024 * 1024) / sample.length));
    const t0 = performance.now();
    r.redact(big);
    const mibPerSec = big.length / 1024 / 1024 / ((performance.now() - t0) / 1000);
    expect(mibPerSec).toBeGreaterThan(1);
  });
});
