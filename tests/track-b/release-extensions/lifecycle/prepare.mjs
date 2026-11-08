import {copyFileSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepareFinalTests} from '../../final-composition/prepare.mjs';
/** Extend historical fixtures for the combined production schema and public pending outcomes. */
export function prepareLifecycleTests(stage,root,migrations={}) {
 const final=prepareFinalTests(stage,root,migrations);
 const target=join(stage,'final-verification/resumption');mkdirSync(target,{recursive:true});
 for(const dir of ['tests/track-b/workflow-resumption-integration','tests/track-b/release-extensions/lifecycle'])for(const name of readdirSync(join(root,dir)).filter(n=>n.endsWith('.test.ts')))copyFileSync(join(root,dir,name),join(target,name));
 // Distinct pending reasons are now the production API; retain each historical case/assertion.
 for(const file of ['final-verification/bridge/rich-driver.test.ts','final-verification/combined/combined-driver.test.ts','final-verification/execution/rich-step.test.ts']) {
  const p=join(stage,file);let source=readFileSync(p,'utf8');
  source=source.replace("['waiting_for_data','pending']","['waiting_for_data','agent_pending']").replace("['waiting_for_review','pending']","['waiting_for_review','review_pending']").replace("['cost_delivery_pending','pending']","['cost_delivery_pending','cost_delivery_pending']");
  source=source.replace("it.each(['waiting_for_data','waiting_for_review','cost_delivery_pending'])('retains %s as pending before approval or dispatch',async status=>{", "it.each([['waiting_for_data','agent_pending'],['waiting_for_review','review_pending'],['cost_delivery_pending','cost_delivery_pending']])('retains %s as pending before approval or dispatch',async (status,outcome)=>{")
   .replace("s.api.advanceData.mockResolvedValue({status});expect(await richEvaluationStep('job','workflow')).toBe('pending');", "s.api.advanceData.mockResolvedValue({status});expect(await richEvaluationStep('job','workflow')).toBe(outcome);");
  if(file.endsWith('execution/rich-step.test.ts'))source=source.replace("toBe('pending')","toBe('agent_pending')");
  writeFileSync(p,source);
 }
 const intake=join(stage,'apps/web/src/server/data-production.test.ts');
 let source=readFileSync(intake,'utf8');
 const migration=migrations['004-workflow-resumption.sql']??'004-workflow-resumption.sql';
 source=source.replace(' fixture.sql={query:',` await db.exec(\`ALTER TABLE jobs ADD COLUMN state text DEFAULT 'planning', ADD COLUMN workflow_run_id text DEFAULT 'workflow-current'; CREATE SCHEMA workflow_integration;\`);\n await db.exec(readFileSync('apps/web/migrations/${migration}','utf8'));\n fixture.sql={query:`);
 writeFileSync(intake,source);
 for(const file of readdirSync(target).filter(n=>n.endsWith('.test.ts'))) {
  const p=join(target,file);let text=readFileSync(p,'utf8');
  for(const [before,after]of Object.entries(migrations))text=text.replaceAll(before,after);
  writeFileSync(p,text);
 }
 return final;
}
