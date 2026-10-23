import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, ERROR_CODES, ToolError, isRecoverable, toolError } from '@autotest/contracts';
import { readDoc, section } from './docs.ts';

const contracts = readDoc('docs/mcp-tool-contracts.md');
const observability = readDoc('docs/observability-and-failure-analysis.md');

const recoverabilityOf = (cell: string): string =>
  cell.startsWith('yes (human)')
    ? 'yes_human'
    : cell.startsWith('no (human)')
      ? 'no_human'
      : cell.startsWith('yes')
        ? 'yes'
        : cell.startsWith('no')
          ? 'no'
          : 'depends';

describe('CON-002 error catalog matches docs', () => {
  const rows = [
    ...section(contracts, '## 3. Error code catalog').matchAll(/^\| `(E_[A-Z_]+)` \| [^|]+ \| ([^|]+) \|/gm),
  ];

  it('has exactly the documented codes, in order', () => {
    expect(rows.map((r) => r[1])).toEqual(ERROR_CODES);
  });

  it('recoverability matches the doc column', () => {
    for (const [, code, cell] of rows) {
      expect(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG].recoverability, code).toBe(
        recoverabilityOf(cell!.trim()),
      );
    }
  });

  it('categories match the observability taxonomy', () => {
    const table = section(observability, '## 3. Error taxonomy');
    const categoryName: Record<string, string> = {
      Input: 'input',
      'Not found / lifecycle': 'lifecycle',
      'Policy / authorization': 'policy',
      Environment: 'environment',
      Evidence: 'evidence',
      External: 'external',
      'Storage / internal': 'internal',
    };
    const patterns: [RegExp, string][] = [];
    for (const m of table.matchAll(/^\| ([^|]+?) \| ([^|]+) \|/gm)) {
      const cat = categoryName[m[1]!.trim()];
      if (!cat) continue;
      for (const p of m[2]!.matchAll(/`(E_[A-Z_]+\*?)`/g))
        patterns.push([new RegExp(`^${p[1]!.replace('*', '.*')}$`), cat]);
    }
    for (const code of ERROR_CODES) {
      const hit = patterns.find(([re]) => re.test(code));
      expect(hit, `no taxonomy row for ${code}`).toBeDefined();
      expect(ERROR_CATALOG[code].category, code).toBe(hit![1]);
    }
  });

  it('builds schema-valid tool errors with bounded text', () => {
    const e = toolError('E_POLICY_DENIED', 'x'.repeat(5000), Array(9).fill('step'), { reasons: ['command_denied'] });
    expect(ToolError.safeParse(e).success).toBe(true);
    expect(e.error.message).toHaveLength(1000);
    expect(e.error.nextSteps).toHaveLength(5);
    expect(isRecoverable('E_PATH_ESCAPE')).toBe(false);
    expect(isRecoverable('E_APPROVAL_REQUIRED')).toBe(true);
  });
});
