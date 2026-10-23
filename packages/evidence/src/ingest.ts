/**
 * Evidence ingestion (EVD-001; FR-031, SR-012; data model §On-disk layout; T-08, T-11).
 *
 * Runner outputs are untrusted files. Each candidate is checked before anything is exposed:
 * - the path must stay inside the run's `attempts/` tree, and the file must be a regular file (symlinks are never
 *   followed: they are quarantined by metadata only);
 * - text kinds must really be text (no NUL in the first 8 KiB, valid UTF-8), or they are quarantined
 *   (`binary_as_text`); text is truncated at the size cap and marked `truncated`;
 * - text is redacted with the policy redactor; a redaction failure quarantines the file (`redaction_failed`);
 * - images are accepted only with a PNG/JPEG signature (stored unredacted, `redaction.applied: false`); other
 *   binary kinds are quarantined (`unsupported_type`), as are oversized binaries (`too_large`).
 * Accepted artifacts are written to `artifacts/<artifactId>` with a generated name; quarantined bytes go to
 * `quarantine/<artifactId>` and are only ever referenced by metadata. Every artifact records its SHA-256 and
 * provenance.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactKind, EvidenceArtifact } from '@autotest/core';
import { RedactionError, type Redactor } from '@autotest/policy';

export interface IngestCandidate {
  readonly kind: ArtifactKind;
  /** Run-dir-relative source path (under `attempts/`). */
  readonly rel: string;
  readonly mimeType: string;
  readonly required: boolean;
  readonly attemptNo?: number;
  /** `supervisor` for process output, the adapter id for runner outputs. */
  readonly producer: string;
  readonly specDigest?: string;
  readonly toolVersion?: string;
}

export interface IngestOptions {
  readonly runDir: string;
  readonly runId: string;
  readonly newId: () => string;
  readonly redactor: Redactor;
  /** Per-artifact cap; text beyond it is truncated, binaries beyond it are quarantined (default 10 MiB). */
  readonly maxBytes?: number;
}

export interface IngestResult {
  readonly artifacts: readonly EvidenceArtifact[];
  /** Required candidates that did not exist. */
  readonly missing: readonly string[];
}

export const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_KINDS: readonly ArtifactKind[] = ['stdout', 'stderr', 'runner_json', 'junit', 'log', 'coverage', 'report'];
const IMAGE_SIGNATURES: readonly { readonly mime: string; readonly magic: readonly number[] }[] = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];

const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

function writePrivate(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

function readBounded(file: string, max: number): { data: Buffer; size: number } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return { data: buf.subarray(0, off), size };
  } finally {
    fs.closeSync(fd);
  }
}

function isUtf8Text(b: Buffer): boolean {
  if (b.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    // A multi-byte sequence cut at the cap is not a reason to reject: retry without the last 3 bytes.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, Math.max(0, b.length - 3)));
      return b.length > 3;
    } catch {
      return false;
    }
  }
}

/** The run-dir-relative path is inside `attempts/`; otherwise undefined. */
export function containedSource(runDir: string, rel: string): string | undefined {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !rel.startsWith('attempts/')) return undefined;
  const abs = path.resolve(runDir, rel);
  return abs.startsWith(`${path.resolve(runDir, 'attempts')}${path.sep}`) ? abs : undefined;
}

export function ingestArtifacts(candidates: readonly IngestCandidate[], o: IngestOptions): IngestResult {
  const max = o.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  const artifacts: EvidenceArtifact[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.rel)) continue;
    seen.add(c.rel);
    const id = o.newId();
    const base = {
      id,
      runId: o.runId,
      ...(c.attemptNo === undefined ? {} : { attemptNo: c.attemptNo }),
      kind: c.kind,
      provenance: {
        producer: c.producer.slice(0, 64),
        ...(c.specDigest ? { specDigest: c.specDigest } : {}),
        ...(c.toolVersion ? { toolVersion: c.toolVersion.slice(0, 64) } : {}),
      },
    };
    const quarantine = (reason: string, data: Uint8Array | undefined, size: number): EvidenceArtifact => {
      const rel = `quarantine/${id}`;
      if (data) writePrivate(path.join(o.runDir, rel), data);
      return {
        ...base,
        relativePath: rel,
        mimeType: 'application/octet-stream',
        sizeBytes: size,
        sha256: sha256(data ?? new Uint8Array()),
        redaction: { applied: false, rulesetVersion: o.redactor.rulesetId, findingsCount: 0 },
        quarantined: true,
        quarantineReason: reason,
        truncated: false,
      };
    };

    const src = containedSource(o.runDir, c.rel);
    if (!src) {
      artifacts.push(quarantine('path_outside_run', undefined, 0));
      continue;
    }
    const st = fs.lstatSync(src, { throwIfNoEntry: false });
    if (!st) {
      if (c.required) missing.push(c.rel);
      continue;
    }
    if (st.isSymbolicLink()) {
      artifacts.push(quarantine('symlink', undefined, 0));
      continue;
    }
    if (!st.isFile()) {
      artifacts.push(quarantine('not_a_file', undefined, 0));
      continue;
    }

    if (TEXT_KINDS.includes(c.kind)) {
      const { data, size } = readBounded(src, max);
      if (!isUtf8Text(data)) {
        artifacts.push(quarantine('binary_as_text', data, size));
        continue;
      }
      let redacted: { text: string; findings: Record<string, number | undefined> };
      try {
        redacted = o.redactor.redact(data.toString('utf8'));
      } catch (e) {
        artifacts.push(quarantine(e instanceof RedactionError ? 'redaction_failed' : 'ingest_failed', data, size));
        continue;
      }
      const out = Buffer.from(redacted.text, 'utf8');
      const rel = `artifacts/${id}`;
      writePrivate(path.join(o.runDir, rel), out);
      artifacts.push({
        ...base,
        relativePath: rel,
        mimeType: c.mimeType.slice(0, 100),
        sizeBytes: out.length,
        sha256: sha256(out),
        redaction: {
          applied: true,
          rulesetVersion: o.redactor.rulesetId,
          findingsCount: Object.values(redacted.findings).reduce((n: number, v) => n + (v ?? 0), 0),
        },
        quarantined: false,
        truncated: size > data.length,
      });
      continue;
    }

    if (st.size > max) {
      artifacts.push(quarantine('too_large', undefined, st.size));
      continue;
    }
    const { data } = readBounded(src, max);
    const image = IMAGE_SIGNATURES.find((s) => s.magic.every((byte, i) => data[i] === byte));
    if (!image || c.kind !== 'screenshot') {
      artifacts.push(quarantine('unsupported_type', data, data.length));
      continue;
    }
    const rel = `artifacts/${id}`;
    writePrivate(path.join(o.runDir, rel), data);
    artifacts.push({
      ...base,
      relativePath: rel,
      mimeType: image.mime,
      sizeBytes: data.length,
      sha256: sha256(data),
      redaction: { applied: false, rulesetVersion: o.redactor.rulesetId, findingsCount: 0 },
      quarantined: false,
      truncated: false,
    });
  }
  return { artifacts, missing };
}

/** Reads up to `bytes` of a stored, non-quarantined artifact (excerpts for TL-15). */
export function readExcerpt(runDir: string, a: EvidenceArtifact, bytes: number): string | undefined {
  if (a.quarantined || !a.relativePath.startsWith('artifacts/') || !TEXT_KINDS.includes(a.kind)) return undefined;
  const file = path.resolve(runDir, a.relativePath);
  if (!file.startsWith(`${path.resolve(runDir, 'artifacts')}${path.sep}`)) return undefined;
  try {
    const { data } = readBounded(file, bytes);
    return new TextDecoder('utf-8', { fatal: false }).decode(data).replace(/�+$/, '');
  } catch {
    return undefined;
  }
}
