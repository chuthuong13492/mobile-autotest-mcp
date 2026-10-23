/**
 * Structured parsing of a PR body (PLN-002; test-planning §Requirement extraction).
 *
 * The body is tokenized with markdown-it (CommonMark; raw HTML recognized so it can be *excluded*). Content inside
 * fenced or indented code, HTML blocks and comments, and block quotes is never parsed as requirements: it is listed
 * in `discarded` instead, which keeps embedded instructions inert. Recognized patterns:
 * - a heading matching the requirements pattern opens a section until the next heading of the same or higher level;
 *   its bullet and checklist items become ACs of one requirement, and a numbered list directly under it yields one
 *   requirement per top-level item with nested items as ACs;
 * - Given/When/Then paragraphs and `AC:` / `AC-n:` lines anywhere become ACs, grouped by their heading.
 * Output is ordered by position in the document, so identical bodies give identical results.
 */
import MarkdownIt from 'markdown-it';
import type { AcFormat } from '@autotest/core';
import { normalizeLine } from './text.ts';

export const REQUIREMENT_HEADING = /^(#+\s*)?(acceptance criteria|requirements?|AC\b|test plan|expected behaviou?r)/i;
const STRIP_KEYWORD = /^(acceptance criteria|requirements?|AC|test plan|expected behaviou?r)\b\s*[:\-–—]?\s*/i;
const AC_LINE = /^AC(?:-\d+)?\s*:\s*(.+)$/i;
const GWT = /^\s*given\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;
const CHECKBOX = /^\[( |x|X)\]\s+/;

export const MAX_AC_LENGTH = 1000;

export interface ParsedAc {
  readonly text: string;
  readonly format: AcFormat;
}

export interface ParsedRequirement {
  readonly title: string;
  readonly acs: ParsedAc[];
  /** Line of the first token that produced it (document order). */
  readonly line: number;
}

export interface Discarded {
  readonly reason: 'code_block' | 'quote' | 'html' | 'over_length';
  readonly excerpt: string;
}

export interface ParsedBody {
  readonly requirements: ParsedRequirement[];
  readonly discarded: Discarded[];
}

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

/** Plain text of an inline token: text and code spans only (emphasis markers, HTML and link syntax dropped). */
function inlineText(t: Token | undefined): string {
  if (!t?.children) return t?.content ?? '';
  let out = '';
  for (const c of t.children) {
    if (c.type === 'text' || c.type === 'code_inline') out += c.content;
    else if (c.type === 'softbreak' || c.type === 'hardbreak') out += '\n';
    else if (c.type === 'image') out += c.content;
  }
  return out;
}

const excerpt = (s: string) => normalizeLine(s).slice(0, 200);

export function parsePrBody(body: string, prTitle: string | undefined): ParsedBody {
  const tokens = md.parse(body, {});
  const discarded: Discarded[] = [];
  const groups = new Map<string, ParsedRequirement>();
  const order: string[] = [];
  let sectionIndex = 0;
  let section: { level: number; key: string; title: string } | undefined;
  let heading: { key: string; title: string } | undefined;
  let listDepth = 0;
  let numberedReq: { key: string; depth: number } | undefined;
  /** Inline tokens already handled as list-item text. */
  const consumed = new Set<number>();

  const group = (key: string, title: string, line: number): ParsedRequirement => {
    let g = groups.get(key);
    if (!g) {
      g = { title: title.slice(0, 200), acs: [], line };
      groups.set(key, g);
      order.push(key);
    }
    return g;
  };
  const addAc = (g: ParsedRequirement, raw: string, format: AcFormat) => {
    const text = normalizeLine(raw);
    if (!text) return;
    if (text.length > MAX_AC_LENGTH) discarded.push({ reason: 'over_length', excerpt: excerpt(text) });
    else g.acs.push({ text, format });
  };
  const fallbackTitle = () => normalizeLine(prTitle ?? '') || 'Requirements';
  /** ACs found by line patterns (GWT, `AC:`) outside list handling. */
  const scanLines = (text: string, line: number) => {
    const target = () =>
      section
        ? group(section.key, section.title, line)
        : heading
          ? group(heading.key, heading.title, line)
          : group('root', fallbackTitle(), line);
    if (GWT.test(text)) {
      addAc(target(), text, 'given_when_then');
      return true;
    }
    let hit = false;
    for (const l of text.split('\n')) {
      const m = AC_LINE.exec(l.trim());
      if (m) {
        addAc(target(), m[1]!, 'freeform');
        hit = true;
      }
    }
    return hit;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const line = t.map?.[0] ?? 0;
    switch (t.type) {
      case 'heading_open': {
        const level = Number(t.tag.slice(1));
        const text = normalizeLine(inlineText(tokens[i + 1]));
        if (section && level <= section.level) section = undefined;
        heading = { key: `h${i}`, title: text || fallbackTitle() };
        if (!section && REQUIREMENT_HEADING.test(text)) {
          sectionIndex++;
          const rest = text.replace(STRIP_KEYWORD, '').trim();
          section = { level, key: `s${i}`, title: rest || `${fallbackTitle()} (section ${sectionIndex})` };
        }
        i += 2;
        break;
      }
      case 'fence':
      case 'code_block':
        discarded.push({ reason: 'code_block', excerpt: excerpt(t.content) });
        break;
      case 'html_block':
        discarded.push({ reason: 'html', excerpt: excerpt(t.content) });
        break;
      case 'blockquote_open': {
        let depth = 1;
        let text = '';
        while (depth > 0 && ++i < tokens.length) {
          const q = tokens[i]!;
          if (q.type === 'blockquote_open') depth++;
          else if (q.type === 'blockquote_close') depth--;
          else if (q.type === 'inline') text += `${inlineText(q)}\n`;
          else if (q.type === 'fence' || q.type === 'code_block') text += `${q.content}\n`;
        }
        discarded.push({ reason: 'quote', excerpt: excerpt(text) });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
        if (t.type === 'ordered_list_open' && section && listDepth === 0) numberedReq = { key: '', depth: 1 };
        listDepth++;
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        listDepth--;
        if (numberedReq && listDepth === 0) numberedReq = undefined;
        break;
      case 'list_item_open': {
        // The item's own text is the first inline token before any nested list.
        let j = i + 1;
        while (
          j < tokens.length &&
          tokens[j]!.type !== 'inline' &&
          tokens[j]!.type !== 'list_item_close' &&
          !tokens[j]!.type.endsWith('_list_open')
        )
          j++;
        const raw = tokens[j]?.type === 'inline' ? inlineText(tokens[j]) : '';
        const checkbox = CHECKBOX.exec(raw.trim());
        const text = checkbox ? raw.trim().replace(CHECKBOX, '') : raw;
        if (numberedReq && listDepth === 1) {
          // Numbered list under a requirements heading: each top-level item is a requirement.
          const key = `n${i}`;
          numberedReq.key = key;
          group(key, normalizeLine(text) || `${section!.title} (item)`, line);
        } else if (numberedReq && numberedReq.key) {
          addAc(groups.get(numberedReq.key)!, text, checkbox ? 'checklist' : 'freeform');
        } else if (section) {
          addAc(group(section.key, section.title, line), text, checkbox ? 'checklist' : 'freeform');
        } else scanLines(text, line);
        // Skip the item's own paragraph so it is not scanned again.
        if (tokens[j]?.type === 'inline') consumed.add(j);
        break;
      }
      case 'inline':
        if (!consumed.has(i)) scanLines(inlineText(t), line);
        break;
      default:
        break;
    }
  }

  const requirements = order
    .map((k) => groups.get(k)!)
    .filter((g, idx) => g.acs.length > 0 || order[idx]!.startsWith('n'));
  return { requirements, discarded };
}
