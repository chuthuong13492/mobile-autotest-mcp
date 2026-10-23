/**
 * Text summaries (MCP-002; mcp-tool-contracts §2.1): one short text block per result, at most 1,000 characters.
 * The full JSON is never echoed. Identifier-like scalars are listed; arrays are counted; untrusted strings appear
 * only with an `[untrusted]` prefix and are clipped.
 */
import type { ToolError, ToolName } from '@autotest/core';
import { isUntrusted } from './untrusted.ts';

export const SUMMARY_MAX = 1000;
const SAFE_SCALAR = /^[A-Za-z0-9_.:/@+-]{1,120}$/;

export function summarizeSuccess(tool: ToolName, output: Record<string, unknown>): string {
  const untrusted = Array.isArray(output['untrustedFields']) ? (output['untrustedFields'] as string[]) : [];
  const parts: string[] = [];
  for (const [k, v] of Object.entries(output)) {
    if (k === 'untrustedFields') continue;
    if (Array.isArray(v)) parts.push(`${k}: ${v.length} item${v.length === 1 ? '' : 's'}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
    else if (typeof v === 'string') {
      if (isUntrusted(`/${k}`, untrusted)) parts.push(`[untrusted] ${k}: "${v.replace(/\s+/g, ' ').slice(0, 80)}"`);
      else if (SAFE_SCALAR.test(v)) parts.push(`${k}: ${v}`);
    }
  }
  return clip(`${tool} completed. ${parts.join('; ')}`.trim());
}

export function summarizeError(e: ToolError): string {
  const steps = e.error.nextSteps.length ? ` Next: ${e.error.nextSteps.join(' ')}` : '';
  return clip(`${e.error.code}: ${e.error.message}${steps}`);
}

const clip = (s: string) => (s.length <= SUMMARY_MAX ? s : `${s.slice(0, SUMMARY_MAX - 1)}…`);
