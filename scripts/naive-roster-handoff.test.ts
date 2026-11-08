import { describe, expect, it } from 'vitest';
import { buildRosterApplicationHandoff } from './naive-roster-handoff';
import { compileRosterStage, type RosterRolloutSpec } from './naive-roster-config';
import { buildCompanyProvisionReceiptExport, type ProvisionStageResult } from './naive-provision-receipts';
import { COMPANY_ROLE_DEFINITIONS, type CompanyRole } from '../packages/core/src/agents/company-roles';
function fixture() {
 const roles=Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
 const spec:RosterRolloutSpec={schemaVersion:'naive_roster_rollout.v1',createRevisionAgents:true,revision:'pilot',model:'test-model',appOrigin:'https://example.com',internalMcpUrl:'https://example.com/api/mcp/internal/mcp',onIdleUrl:'https://example.com/api/naive/idle/SECRET_CALLBACK_TOKEN',credentialFiles:{},schedules:{}};
 for(const role of roles){const d=COMPANY_ROLE_DEFINITIONS[role];if(Object.keys(d.tools).some(t=>t.startsWith('se_internal.')))spec.credentialFiles[role]=`/private/secrets/${role}`;
 if(d.deployment)spec.schedules[role]={cron:'0 7 * * *',timezone:'UTC',inputTemplate:'SECRET_INPUT_CONTENT'};}
 const exports:unknown[]=[];let counter=0;
 for(let i=0;i<5;i++){
  const {options,plan}=compileRosterStage(spec,exports);
  const results=plan.operations.map(op=>({kind:op.kind,name:op.kind==='agent'?op.body.name:op.kind==='skill'?op.body.slug:op.kind==='outcome'?op.body.name:op.kind==='vault'?op.body.display_name:op.kind==='credential'?op.body.key:op.name,status:'created',receipt:{id:`${({skill:'skl',outcome:'ocm',vault:'vlt',agent:'agt',credential:'vcr',deployment:'dep'})[op.kind]}_${String(++counter).padStart(26,'0')}`,...(['skill','agent'].includes(op.kind)?{version:3}:{})}})) as ProvisionStageResult[];
  exports.push(buildCompanyProvisionReceiptExport(options,plan,results));
 }
 return {spec,exports};
}
describe('terminal roster application handoff',()=>{
 it('pins every exact manifest role, permissions, coordinator and paused deployment identity',()=>{
  const {spec,exports}=fixture();const h=buildRosterApplicationHandoff(spec,exports);
  expect(h.applyReady).toBe(false);expect(h.roles).toHaveLength(15);expect(h.deployments).toHaveLength(5);
  for(const role of h.roles){expect(h.environment[COMPANY_ROLE_DEFINITIONS[role.role].env]).toBe(`${role.agentId}@3`);expect(role.mcpTools).toEqual(Object.fromEntries(Object.entries(COMPANY_ROLE_DEFINITIONS[role.role].tools).filter(([key])=>key.startsWith('se_internal.'))));}
  for(const d of h.deployments){expect(d.agentPin).toBe(h.roles.find(r=>r.role===d.role)!.pin);expect(d.enabled).toBe(false);expect(d.deploymentId).toMatch(/^dep_/);}
  expect(h.coordinator.members.map(m=>m.role)).toEqual(['market_researcher','prospector','outreach','onboarding']);
  const serialized=JSON.stringify(h);expect(serialized).not.toMatch(/\/private\/|SECRET_CALLBACK_TOKEN|SECRET_INPUT_CONTENT|credentialFiles|valueFile/);
  expect(h.evidence).toBe('retained_attestation_not_fresh_authority');expect(h.blockers.length).toBeGreaterThan(5);
 });
 it.each([0,1,2,3,4])('rejects incomplete chain at %i stages',length=>{const {spec,exports}=fixture();expect(()=>buildRosterApplicationHandoff(spec,exports.slice(0,length))).toThrow();});
 it.each(['stale','swap','duplicate','wrongname','wrongagent'] as const)('rejects %s evidence',mode=>{
  const {spec,exports}=fixture();const rows=exports as any[];
  if(mode==='stale')spec.model='different-model';
  if(mode==='swap')[rows[1],rows[2]]=[rows[2],rows[1]];
  if(mode==='duplicate')rows[4].resources[1].id=rows[4].resources[0].id;
  if(mode==='wrongname')rows[4].resources[0].name=rows[4].resources[1].name;
  if(mode==='wrongagent')rows[4].receipts.agents.planner.version=99;
  expect(()=>buildRosterApplicationHandoff(spec,exports)).toThrow();
 });
});
