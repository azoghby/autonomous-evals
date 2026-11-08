import { containsSecret } from '../../agents/redact';
import type { TextTargetPort } from '../types';
import { canonicalJson } from '../text/freeze';
import { trustedSpecDigest, supportedSemantic, type TrustedRegistry, type TrustedRedTeamSpec, type PackProvenance } from './trusted';
import type { SecuredPackRunner, PackCheckEvidence } from './execution';

/** Server-resolved, non-secret identity of the actual target configuration. Never intake labels. */
export interface PackTargetConfiguration {
  endpoint: string;
  model: string;
  configurationVersion: string;
  systemPrompt: string | null;
}
export function actualPackTargetDigest(config: PackTargetConfiguration): string {
  if (!config.endpoint || !config.model || !config.configurationVersion || containsSecret(canonicalJson(config))) throw new Error('pack_invalid_target_configuration');
  return trustedSpecDigest(config);
}

/** Code-owned adapter to the pinned Track A gradeRedTeam, NOT an executable stored spec.
 * gradeRule must use that grader on exactly spec.rules[index], retaining all encoding semantics.
 * Regex, tool, multi-turn, plant, injection and rubric cases never reach this port in v1. */
export interface TrustedPackGrader {
  provenance: PackProvenance;
  gradeRule(spec: TrustedRedTeamSpec, index: number, response: string): {
    passed: boolean; evidence: Array<{ excerpt: string }>;
  };
}

/** Reuses createTextTarget's secured TextTargetPort; no HTTP or second grading engine here.
 * The enclosing execution service durably fences the entire single target dispatch. */
export function createSecuredTextPackRunner(deps: {
  target: TextTargetPort;
  configuration: PackTargetConfiguration;
  registry: TrustedRegistry;
  grader?: TrustedPackGrader;
  knownSecrets?: readonly string[];
}): SecuredPackRunner {
  const config = JSON.parse(JSON.stringify(deps.configuration)) as PackTargetConfiguration;
  const targetConfigDigest = actualPackTargetDigest(config);
  const provenance = canonicalJson(deps.registry.provenance);
  return {
    capabilityVersion: 'secured_pack_runner.v1',
    supports(entry, context) {
      return Boolean(deps.grader && canonicalJson(deps.grader.provenance) === provenance
        && canonicalJson(context.provenance) === provenance
        && entry.spec && supportedSemantic(entry.spec) === entry.semanticType);
    },
    async execute(entry, context) {
      if (context.targetConfigDigest !== targetConfigDigest) throw new Error('pack_actual_target_configuration_mismatch');
      if (canonicalJson(context.provenance) !== provenance) throw new Error('pack_source_provenance_mismatch');
      const trusted = deps.registry.specs.find(s => s.id === entry.id);
      if (!trusted || trustedSpecDigest(trusted) !== entry.specDigest || canonicalJson(trusted) !== canonicalJson(entry.spec)) throw new Error('pack_untrusted_dispatch');
      if (!deps.grader || canonicalJson(deps.grader.provenance) !== provenance || supportedSemantic(trusted) !== entry.semanticType) {
        return { id: entry.id, specDigest: entry.specDigest, status: 'quarantined', checks: [], reason: 'exact_trusted_grader_unavailable' };
      }
      // Never copy a provider body/error into evidence. Throws remain fenced as ambiguous.
      const response = await deps.target.send({scenarioId: entry.id, runId: context.runId, systemPrompt: config.systemPrompt, userMessage: trusted.turns[0]!});
      if (!response || response.ok !== true || typeof response.text !== 'string' || !Number.isFinite(response.latencyMs) || response.latencyMs < 0) throw new Error('pack_target_execution_unknown');
      if (containsSecret(response.text, deps.knownSecrets)) throw new Error('pack_credential_in_response');
      const checks: PackCheckEvidence[] = trusted.rules.map((_, index) => {
        const grade = deps.grader!.gradeRule(trusted, index, response.text);
        if (typeof grade.passed !== 'boolean' || !Array.isArray(grade.evidence)) throw new Error('pack_invalid_trusted_grade');
        return { id: `${entry.id}.rule.${index + 1}`, status: grade.passed ? 'pass' : 'fail', detail: grade.passed ? 'Trusted source rule passed.' : 'Trusted source rule failed.',
          evidenceQuotes: grade.evidence.map(e => e.excerpt).filter(q => typeof q === 'string' && q.length > 0 && response.text.includes(q)).slice(0, 6).map(q => q.slice(0, 500)) };
      });
      return {id:entry.id, specDigest:entry.specDigest, status:checks.some(c=>c.status==='fail')?'fail':'pass', checks};
    },
  };
}
