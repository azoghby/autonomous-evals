/** Advisory evidence only: this proposal grants no data, expert, outreach or payment authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { containsSecret } from '../../agents/redact';
import { canonicalJson } from './freeze';
import { RubricCheckSchema, TextScenarioSchema, normalizeReferenceText } from './schema';
import type { TextDesignInput } from './design';
import { TrackBBlockedError } from '../service-adapter';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const FactualGapProposalSchema = z.object({
  schemaVersion: z.literal('text_factual_gap.v1'),
  authority: z.literal('model_proposed_coverage_requires_owner_validation'),
  inputDigest: Digest,
  requirements: z.array(z.object({
    reason: z.literal('factual_check_missing_reference'),
    scenarioId: z.string().regex(/^S(?:0[1-9]|1[0-2])$/),
    userMessage: TextScenarioSchema.shape.userMessage,
    check: RubricCheckSchema,
  }).strict()).min(1).max(36),
}).strict();
export type FactualGapProposal = z.infer<typeof FactualGapProposalSchema>;
export function factualGapInputDigest(input: { job: Pick<TextDesignInput['job'], 'jobId' | 'customerId' | 'environment'>; versionLabel: string; systemPrompt: string | null; referenceText: string | null }): string {
  return createHash('sha256').update(canonicalJson({ jobId: input.job.jobId, customerId: input.job.customerId,
    environment: input.job.environment, versionLabel: input.versionLabel, systemPrompt: input.systemPrompt,
    referenceText: normalizeReferenceText(input.referenceText) })).digest('hex');
}
/** Caller must first establish all ordinary schema/objective/rubric admissions. Never
 * derive coverage from free-form rejection reasons or model explanations. */
export function proposeFactualGap(input: TextDesignInput, scenarios: readonly z.infer<typeof TextScenarioSchema>[]): FactualGapProposal | null {
  if (normalizeReferenceText(input.referenceText) !== null) return null;
  const requirements = scenarios.flatMap(s => s.rubricChecks.filter(c => c.assessesFactualCorrectness && c.requiresReference
    && c.behavioralInstructionId === undefined && c.conditionalInstructionId === undefined)
    .map(check => ({ reason: 'factual_check_missing_reference' as const, scenarioId: s.id, userMessage: s.userMessage, check: structuredClone(check) })));
  if (!requirements.length) return null;
  const parsed = FactualGapProposalSchema.safeParse({ schemaVersion: 'text_factual_gap.v1', authority: 'model_proposed_coverage_requires_owner_validation', inputDigest: factualGapInputDigest(input), requirements });
  if (!parsed.success || containsSecret(JSON.stringify(parsed.data), input.knownSecrets ?? [])) return null;
  return parsed.data;
}
export class TextFactualGapError extends TrackBBlockedError {
  readonly proposal: FactualGapProposal;
  constructor(proposal: FactualGapProposal, readonly canonicalInputDigest: string) {
    super('needs_operator', 'Proposed factual coverage lacks reference evidence and requires owner validation.');
    this.name = 'TextFactualGapError';
    this.proposal = structuredClone(FactualGapProposalSchema.parse(proposal));
  }
}
