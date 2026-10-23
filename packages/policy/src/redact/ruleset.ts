/**
 * Redaction ruleset `redact-1` (POL-005; data model §Retention and redaction). Changing any pattern requires a new
 * ruleset id so reports can state which rules were applied (RK-05).
 */

export const RULESET_ID = 'redact-1' as const;

/** Finding classes; counts are reported per class, values never are. */
export type FindingClass =
  | 'known_value'
  | 'private_key'
  | 'github_token'
  | 'aws_access_key'
  | 'slack_token'
  | 'jwt'
  | 'authorization'
  | 'bearer'
  | 'url_credentials'
  | 'credential_assignment'
  | 'high_entropy';

export interface PatternRule {
  readonly id: FindingClass;
  /** Global regex. A named group `keep` is preserved before the marker and `tail` after it. */
  readonly pattern: RegExp;
}

export const PATTERN_RULES: readonly PatternRule[] = [
  { id: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,250})\b/g },
  { id: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,250}/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: 'authorization',
    pattern: /(?<keep>\b(?:Proxy-)?Authorization["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token|Digest)\s+)?)[^\s'",;]+/gi,
  },
  { id: 'bearer', pattern: /(?<keep>\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g },
  {
    id: 'url_credentials',
    pattern: /(?<keep>\b[a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:@/]{1,200}:[^\s@/]{1,200}(?<tail>@)/gi,
  },
  {
    id: 'credential_assignment',
    pattern:
      /(?<keep>\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*["']?)[^\s"',;{}]{4,}/gi,
  },
];

export const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
export const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

/** High-entropy candidates: long runs of token characters. `/` is excluded so file paths are not candidates. */
export const ENTROPY_CANDIDATE = /[A-Za-z0-9+_=-]{24,}/g;
export const DEFAULT_ENTROPY_THRESHOLD = 4.0;

/** Formats this system emits itself; never treated as secrets (data model: "allowlist of known safe formats"). */
export const SAFE_FORMATS: readonly RegExp[] = [
  /^[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{26}$/, // server-minted handles (ULID)
  /^TT-[a-z0-9-]+-[0-9a-f]{12}$/, // TestTarget ids
  /^[0-9a-f]+$/i, // hex digests (commit SHAs, sha256 values)
];
