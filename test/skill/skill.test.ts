/**
 * SKL-001: the Skill matches the implemented server. Frontmatter follows the Agent Skills rules, every reference
 * link resolves, every tool the workflow calls exists, every error code exists, the Phase 1 tools are all covered,
 * and the assembled Claude Code plugin passes `claude plugin validate --strict` (when the CLI is installed).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, TOOLS } from '@autotest/core';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL_DIR = path.join(ROOT, 'skills', 'pr-mobile-autotest');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const references = fs
  .readdirSync(path.join(SKILL_DIR, 'references'))
  .map((f) => [f, fs.readFileSync(path.join(SKILL_DIR, 'references', f), 'utf8')] as const);
const all = [skill, ...references.map(([, t]) => t)].join('\n');
const toolNames = new Set<string>(TOOLS.map((t) => t.name));

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter');
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

describe('SKL-001 Skill packaging', () => {
  it('frontmatter: name matches the folder, description and compatibility within limits, version set', () => {
    const fm = frontmatter(skill);
    expect(fm['name']).toBe('pr-mobile-autotest');
    expect(fm['name']).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm['description']!.length).toBeGreaterThan(50);
    expect(fm['description']!.length).toBeLessThanOrEqual(1024);
    expect(fm['compatibility']!.length).toBeLessThanOrEqual(500);
    expect(skill).toMatch(/\n {2}version: "1\.1\.0"\n/);
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('every relative link resolves', () => {
    for (const [file, text] of [['SKILL.md', skill] as const, ...references]) {
      const base = file === 'SKILL.md' ? SKILL_DIR : path.join(SKILL_DIR, 'references');
      for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z]+:/.test(target)) continue;
        expect(fs.existsSync(path.join(base, target)), `${file} → ${target}`).toBe(true);
      }
    }
  });

  it('every tool the Skill calls exists, and every Phase 1 tool appears in the workflow', () => {
    // Any backticked name shaped like a tool (verb_noun with a tool verb) must be a real tool: catches typos.
    const toolish =
      /^(get|inspect|extract|generate|validate|request|run|cancel|collect|analyze|publish|list|manage)_[a-z_]+$/;
    const states = new Set(['cancel_pending']);
    const named = [...all.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((n) => toolish.test(n) && !states.has(n));
    expect(new Set(named).size).toBeGreaterThan(14);
    for (const t of named) expect(toolNames.has(t), t).toBe(true);
    for (const t of [
      'get_pr_context',
      'inspect_project',
      'inspect_test_inventory',
      'extract_requirements',
      'generate_test_plan',
      'validate_test_coverage',
      'request_approval',
      'get_approval_status',
      'run_tests',
      'get_run_status',
      'get_run_results',
      'cancel_test_run',
      'collect_test_evidence',
      'analyze_test_failures',
      'generate_pr_test_report',
    ])
      expect(skill, t).toContain(`\`${t}\``);
  });

  it('every error code named in the Skill or its references exists', () => {
    const codes = new Set<string>(ERROR_CODES);
    for (const m of all.matchAll(/`(E_[A-Z_]+?)(\*?)`/g)) {
      if (m[2] === '*')
        expect(
          [...codes].some((c) => c.startsWith(m[1]!)),
          m[1],
        ).toBe(true);
      else expect(codes.has(m[1]!), m[1]).toBe(true);
    }
  });

  it('the assembled plugin passes `claude plugin validate --strict`', { timeout: 60_000 }, (ctx) => {
    const claude = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
    if (!claude) return ctx.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-plugin-'));
    fs.cpSync(path.join(ROOT, 'plugin'), dir, { recursive: true });
    fs.rmSync(path.join(dir, 'README.md'));
    fs.cpSync(SKILL_DIR, path.join(dir, 'skills', 'pr-mobile-autotest'), { recursive: true });
    const r = spawnSync(claude, ['plugin', 'validate', '--strict', dir], { encoding: 'utf8', timeout: 50_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
