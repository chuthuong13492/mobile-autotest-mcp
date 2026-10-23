/**
 * Requirement-set assembly (PLN-002; test-planning §Requirement extraction; TL-04).
 *
 * Parsed requirements come first in document order, then agent requirements in input order. An agent requirement
 * merges into a parsed one when its normalized title equals the parsed title or its normalized statement equals
 * the parsed statement (exact text; fuzzy de-duplication is deliberately not done). On a merge the parsed text and
 * provenance win and the agent's metadata (kind, platforms, risk factors, testability) is attached; agent ACs merge
 * into parsed ACs with identical normalized text, otherwise they are appended with `provenance: agent`.
 *
 * The server assigns all IDs (REQ-NNN, REQ-NNN.AC-NN, AMB-NN, ASM-NN), computes risk tiers, and raises ambiguities
 * with their severity floors: `missing_ac` (high) for a testable requirement without ACs, and `vague_term` (medium,
 * high for R2/R3) for an AC that uses the vague-term lexicon. Agent text is data: nothing in it changes behaviour.
 */
import {
  acId,
  formatSeqId,
  type AcFormat,
  type Ambiguity,
  type Assumption,
  type Platform,
  type Requirement,
  type RequirementKind,
  type RiskFactors,
} from '@autotest/core';
import { assessRisk, type RiskPolicy } from '../risk.ts';
import type { Discarded, ParsedBody } from './markdown.ts';
import { containsVagueTerm, isObservable, normalizeLine } from './text.ts';

export interface AgentRequirement {
  readonly title: string;
  readonly statement: string;
  readonly kind: RequirementKind;
  readonly testable: boolean;
  readonly nonTestableReason?: string | undefined;
  readonly platforms: readonly Platform[];
  readonly riskFactors?: RiskFactors | undefined;
  readonly acceptanceCriteria: readonly { readonly text: string; readonly format: AcFormat }[];
}

export interface AssembleInput {
  readonly parsed: ParsedBody;
  readonly agentRequirements: readonly AgentRequirement[];
  readonly agentAmbiguities: readonly {
    readonly text: string;
    readonly severity: Ambiguity['severity'];
    readonly relatedKeys: readonly string[];
  }[];
  readonly agentAssumptions: readonly { readonly text: string }[];
  readonly mode: 'parsed_only' | 'parsed_and_agent';
  readonly riskPolicy: RiskPolicy;
  readonly observableVerbs?: readonly string[];
  readonly vagueTerms?: readonly string[];
}

export interface AssembledSet {
  readonly requirements: Requirement[];
  readonly ambiguities: Ambiguity[];
  readonly assumptions: Assumption[];
  readonly parseReport: { parsedCount: number; agentCount: number; mergedDuplicates: number; discarded: Discarded[] };
}

interface Draft {
  title: string;
  statement: string;
  kind: RequirementKind;
  testable: boolean;
  nonTestableReason?: string;
  provenance: 'parsed' | 'agent';
  platforms: Platform[];
  riskFactors?: RiskFactors;
  acs: { text: string; format: AcFormat; provenance: 'parsed' | 'agent' }[];
}

const MAX_REQUIREMENTS = 200;
const MAX_ACS = 30;

export function assembleRequirementSet(input: AssembleInput): AssembledSet {
  const discarded = [...input.parsed.discarded];
  const drafts: Draft[] = input.parsed.requirements.map((p) => ({
    title: p.title,
    statement: p.title,
    kind: 'functional',
    testable: true,
    provenance: 'parsed',
    platforms: [],
    acs: p.acs.map((a) => ({ ...a, provenance: 'parsed' as const })),
  }));
  const parsedCount = drafts.length;
  let merged = 0;
  const agent = input.mode === 'parsed_and_agent' ? input.agentRequirements : [];

  for (const a of agent) {
    const title = normalizeLine(a.title).slice(0, 200);
    const statement = normalizeLine(a.statement).slice(0, 2000);
    const acs = a.acceptanceCriteria
      .map((c) => ({ text: normalizeLine(c.text), format: c.format, provenance: 'agent' as const }))
      .filter((c) => c.text);
    const match = drafts.find((d) => d.provenance === 'parsed' && (d.title === title || d.statement === statement));
    const meta = {
      kind: a.kind,
      testable: a.testable,
      platforms: [...new Set(a.platforms)],
      ...(a.nonTestableReason ? { nonTestableReason: normalizeLine(a.nonTestableReason).slice(0, 500) } : {}),
      ...(a.riskFactors ? { riskFactors: a.riskFactors } : {}),
    };
    if (match) {
      merged++;
      Object.assign(match, meta);
      for (const c of acs) {
        if (match.acs.some((x) => x.text === c.text)) merged++;
        else match.acs.push(c);
      }
    } else drafts.push({ title, statement, provenance: 'agent', ...meta, acs });
  }

  for (const d of drafts.slice(MAX_REQUIREMENTS))
    discarded.push({
      reason: 'over_length',
      excerpt: `requirement beyond ${MAX_REQUIREMENTS}: ${d.title}`.slice(0, 200),
    });
  const kept = drafts.slice(0, MAX_REQUIREMENTS);

  const ambiguities: Omit<Ambiguity, 'id'>[] = [];
  const requirements: Requirement[] = kept.map((d, i) => {
    const id = formatSeqId('REQ', i + 1);
    for (const c of d.acs.slice(MAX_ACS))
      discarded.push({ reason: 'over_length', excerpt: `AC beyond ${MAX_ACS} for ${id}: ${c.text}`.slice(0, 200) });
    const risk = assessRisk(d.riskFactors, input.riskPolicy);
    const acceptanceCriteria = d.acs.slice(0, MAX_ACS).map((c, j) => ({
      id: acId(id, j + 1),
      text: c.text.slice(0, 1000),
      format: c.format,
      observable: isObservable(c.text, input.observableVerbs),
      provenance: c.provenance,
    }));
    const testable = d.testable || !d.nonTestableReason;
    if (testable && acceptanceCriteria.length === 0)
      ambiguities.push({
        type: 'missing_ac',
        text: `${id} has no acceptance criteria`,
        severity: 'high',
        relatedRefs: [id],
        status: 'open',
      });
    for (const ac of acceptanceCriteria) {
      if (containsVagueTerm(ac.text, input.vagueTerms)) {
        ambiguities.push({
          type: 'vague_term',
          text: `${ac.id} uses a vague term`,
          severity: risk.tier === 'R2' || risk.tier === 'R3' ? 'high' : 'medium',
          relatedRefs: [ac.id],
          status: 'open',
        });
      }
    }
    return {
      id,
      title: d.title || id,
      statement: d.statement || d.title || id,
      kind: d.kind,
      testable,
      ...(testable ? {} : { nonTestableReason: d.nonTestableReason! }),
      provenance: d.provenance,
      platforms: d.platforms,
      riskFactors: risk.factors,
      riskTier: risk.tier,
      acceptanceCriteria,
    };
  });

  const knownRefs = new Set(requirements.flatMap((r) => [r.id, ...r.acceptanceCriteria.map((a) => a.id)]));
  if (input.mode === 'parsed_and_agent') {
    for (const a of input.agentAmbiguities) {
      ambiguities.push({
        text: normalizeLine(a.text).slice(0, 1000),
        severity: a.severity,
        relatedRefs: [...new Set(a.relatedKeys.filter((k) => knownRefs.has(k)))],
        status: 'open',
      });
    }
  }
  const assumptions: Assumption[] = (input.mode === 'parsed_and_agent' ? input.agentAssumptions : [])
    .slice(0, 100)
    .map((a, i) => ({ id: formatSeqId('ASM', i + 1, 2), text: normalizeLine(a.text).slice(0, 1000), relatedRefs: [] }));

  return {
    requirements,
    ambiguities: ambiguities.slice(0, 100).map((a, i) => ({ id: formatSeqId('AMB', i + 1, 2), ...a })),
    assumptions,
    parseReport: {
      parsedCount,
      agentCount: agent.length,
      mergedDuplicates: merged,
      discarded: discarded.slice(0, 100),
    },
  };
}
