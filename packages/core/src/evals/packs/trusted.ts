import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../text/freeze';

const text = (max: number) => z.string().min(1).max(max);
const NotContains = z.object({ kind: z.literal('not_contains'), label: text(200), values: z.array(text(300)).default([]), patterns: z.array(text(300)).default([]), mode: z.enum(['anywhere', 'leading']).default('anywhere'), includeToolArgs: z.boolean().default(true) }).strict();
export const TrustedRedTeamSpecSchema = z.object({
  id: z.string().regex(/^rt_[a-z0-9_]+$/).max(64), category: z.enum(['prompt_injection', 'jailbreak', 'system_prompt_extraction', 'tool_misuse', 'data_exfiltration', 'harmful_compliance', 'over_refusal']),
  severity: z.enum(['critical', 'high', 'medium', 'low']), title: text(300), description: text(1000),
  requires: z.object({ tools: z.boolean().default(false), systemPrompt: z.boolean().default(false) }).strict().default({ tools: false, systemPrompt: false }),
  turns: z.array(text(4000)).min(1).max(6),
  inject: z.discriminatedUnion('kind', [z.object({kind: z.literal('document'), content: z.string().max(5000)}).strict(), z.object({kind: z.literal('tool_output'), toolName: text(100), content: z.string().max(5000)}).strict()]).optional(),
  plant: z.object({systemPrompt: z.string().max(2000)}).strict().optional(), canaries: z.array(text(300)).default([]),
  rules: z.array(z.discriminatedUnion('kind', [NotContains, z.object({kind:z.literal('refuses')}).strict(), z.object({kind:z.literal('complies'), requireAny:z.array(text(300)).min(1), example:z.string().max(500)}).strict(), z.object({kind:z.literal('safe_completion'), requireAny:z.array(text(300)).min(1), example:z.string().max(500)}).strict(), z.object({kind:z.literal('no_tool_call'), label:text(200), tools:z.array(text(300)).min(1), argMatch:z.string().max(300).optional()}).strict()])).min(1),
  rubric: z.string().max(1000).optional(),
}).strict();
export type TrustedRedTeamSpec = z.infer<typeof TrustedRedTeamSpecSchema>;
export interface PackProvenance { sourceRevision: string; sourcePath: 'packages/core/src/redteam/library.ts'; libraryDigest: string }
export interface TrustedRegistry { readonly provenance: PackProvenance; readonly specs: readonly TrustedRedTeamSpec[] }
export const trustedSpecDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
/** Trusted composition-root API, never an intake/spec loader. The caller must pin and review
 * sourceRevision and the complete data library. Stored Scenario.checks[].spec is never read. */
export function createTrustedRegistry(input: {sourceRevision:string; sourcePath:string; specs: readonly unknown[]}): TrustedRegistry {
  if (!/^[0-9a-f]{40}$/.test(input.sourceRevision) || input.sourcePath !== 'packages/core/src/redteam/library.ts') throw new Error('pack_unpinned_source');
  const specs = input.specs.map(spec => TrustedRedTeamSpecSchema.parse(spec));
  if (!specs.length || specs.length > 100 || new Set(specs.map(s=>s.id)).size !== specs.length) throw new Error('pack_invalid_registry_inventory');
  return immutable({provenance:{sourceRevision:input.sourceRevision, sourcePath:input.sourcePath, libraryDigest:trustedSpecDigest(specs)}, specs});
}
/** Accepted means representable by the port contract, never an assertion that it ran.
 * An executor without the exact trusted Track A grader capability must quarantine. */
export function supportedSemantic(spec: TrustedRedTeamSpec): 'redteam.literal_response.v1' | null {
  return spec.turns.length === 1 && !spec.inject && !spec.plant && !spec.rubric && !spec.requires.tools && !spec.requires.systemPrompt
    && spec.rules.every(rule=>rule.kind === 'not_contains' && rule.values.length > 0 && rule.patterns.length === 0 && !rule.includeToolArgs)
    ? 'redteam.literal_response.v1' : null;
}
