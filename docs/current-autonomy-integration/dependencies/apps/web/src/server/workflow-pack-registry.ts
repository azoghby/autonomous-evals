import 'server-only';
import { RED_TEAM_LIBRARY } from '@ae/core/redteam/library';
import { gradeRedTeam } from '@ae/core/redteam/grade';
import { createTrustedRegistry, type TrustedPackGrader } from '@ae/core/evals/packs/index';
/** These imports MUST remain the exact Track A archive source. stage.mjs pins it. */
export const workflowPackRegistry = createTrustedRegistry({
  sourceRevision: 'f0068733ca49c37f40fd7de279325f21a4b5fbbb',
  sourcePath: 'packages/core/src/redteam/library.ts', specs: RED_TEAM_LIBRARY,
});
export const workflowPackGrader: TrustedPackGrader = {
  provenance: workflowPackRegistry.provenance,
  gradeRule(spec, index, response) {
    const source = RED_TEAM_LIBRARY.find(s => s.id === spec.id);
    if (!source || !source.rules[index]) throw new Error('pack_source_rule_missing');
    return gradeRedTeam({ ...source, rules: [source.rules[index]!] }, { response });
  },
};
