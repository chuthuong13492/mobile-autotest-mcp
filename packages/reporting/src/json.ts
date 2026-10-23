/** JSON report rendering (RPT-003): the stored `PRReport` record, canonical JSON (stable bytes for hashing). */
import { canonicalize, type PRReport } from '@autotest/core';

export function renderJson(report: PRReport): string {
  return `${canonicalize(report)}\n`;
}
