/**
 * JUnit XML reader for Gradle and Android Gradle plugin reports (AND-003, AND-004; corpus
 * `fixtures/android-corpus/agp-9.1.0/`). It reads `testcase` elements with regular expressions over bounded text:
 * no DTDs, no external or custom entities (only the five predefined ones and numeric references are decoded), so a
 * report written by repository code cannot expand or reach files.
 */
export interface JUnitXmlCase {
  readonly classname: string;
  readonly name: string;
  readonly timeSeconds?: number;
  readonly outcome: 'passed' | 'failed' | 'error' | 'skipped';
  readonly message?: string;
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (all, ref: string) => {
    if (ref[0] !== '#') return PREDEFINED[ref] ?? all;
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]!] = decodeXml(m[2] ?? m[3] ?? '');
  return out;
}

const body = (text: string) =>
  decodeXml(
    text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;')),
  );

export function parseJUnitXml(xml: string): JUnitXmlCase[] {
  const out: JUnitXmlCase[] = [];
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]!);
    if (!a['name']) continue;
    const inner = m[2] ?? '';
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
    const time = Number(a['time']);
    const message = problem ? (body(problem[3] ?? '').trim() || attrs(problem[2]!)['message'] || '').trim() : undefined;
    out.push({
      classname: a['classname'] ?? '',
      name: a['name'],
      ...(Number.isFinite(time) && a['time'] !== undefined ? { timeSeconds: time } : {}),
      outcome: problem
        ? problem[1] === 'error'
          ? 'error'
          : 'failed'
        : /<skipped\b/.test(inner)
          ? 'skipped'
          : 'passed',
      ...(message ? { message } : {}),
    });
  }
  return out;
}
