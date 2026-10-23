/**
 * Shared primitives: identifier formats, hashes, limitations, artifact references, pagination (data model §1–§2).
 */
import { z } from 'zod';
import { ArtifactKind } from './enums.ts';

/** Crockford base32 ULID (26 chars). */
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** Server-minted opaque handle `<prefix>_<ULID>`. */
export const handle = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_${ULID}$`), `expected ${prefix}_<ULID>`);

export const PrContextId = handle('prc');
export const ProjectProfileId = handle('prj');
export const InventoryId = handle('inv');
export const RequirementSetId = handle('rqs');
export const PlanId = handle('plan');
export const CoverageDecisionId = handle('cov');
export const ApprovalRequestId = handle('apr');
export const ApprovalId = handle('appr');
export const AuthorizationId = handle('authz');
export const RunId = handle('run');
export const ResultId = handle('res');
export const ArtifactId = handle('art');
export const AnalysisId = handle('fa');
export const ReportId = handle('rpt');
export const AuditEventId = handle('aud');
export const LeaseId = handle('lease');

export const ReqId = z.string().regex(/^REQ-\d{3}$/, 'expected REQ-NNN');
export const AcId = z.string().regex(/^REQ-\d{3}\.AC-\d{2}$/, 'expected REQ-NNN.AC-NN');
export const TcId = z.string().regex(/^TC-\d{3}$/, 'expected TC-NNN');
export const ExcId = z.string().regex(/^EXC-\d{3}$/, 'expected EXC-NNN');
export const AmbId = z.string().regex(/^AMB-\d{2}$/, 'expected AMB-NN');
export const AsmId = z.string().regex(/^ASM-\d{2}$/, 'expected ASM-NN');
export const TestTargetId = z.string().regex(/^TT-[a-z0-9-]+-[0-9a-f]{12}$/, 'expected TT-<adapter>-<12 hex>');

export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');
/** Plan hash `v<hashVersion>:sha256:<64 hex>` (data model §Plan hash). */
export const PlanHash = z.string().regex(/^v\d+:sha256:[0-9a-f]{64}$/, 'expected v<N>:sha256:<64 hex>');

export const Timestamp = z.iso.datetime({ offset: false });
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const Cursor = z.string().min(1).max(4096);
export const Limit = (max = 200, dflt = 50) => z.number().int().min(1).max(max).default(dflt);

/** A documented limitation attached to a result (machine code + human message). */
export const Limitation = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_:]*$/),
  message: z.string().max(500),
});
export type Limitation = z.infer<typeof Limitation>;

/** JSON pointers to fields that carry untrusted (repository/PR/runner-derived) content (SR-006). */
export const UntrustedFields = z.array(z.string().max(200)).max(50);

export const RepositoryIdentity = z.strictObject({
  host: z.string().min(1).max(255),
  owner: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100).optional(),
  localPath: z.string().min(1).max(1024).optional(),
});
export type RepositoryIdentity = z.infer<typeof RepositoryIdentity>;

export const RefInfo = z.strictObject({
  ref: z.string().min(1).max(255),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export type RefInfo = z.infer<typeof RefInfo>;

export const ChangedFile = z.strictObject({
  path: z.string().min(1).max(1024),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** Reference to a stored evidence artifact; content is never inlined (mcp-tool-contracts §2.4). */
export const ArtifactRef = z.strictObject({
  artifactId: ArtifactId,
  kind: ArtifactKind,
  sizeBytes: z.number().int().min(0),
  sha256: Sha256,
  mimeType: z.string().min(1).max(100),
  quarantined: z.boolean(),
  uri: z.string().regex(/^autotest:\/\/runs\/run_[0-9A-HJKMNP-TV-Z]{26}\/artifacts\/art_[0-9A-HJKMNP-TV-Z]{26}$/),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
