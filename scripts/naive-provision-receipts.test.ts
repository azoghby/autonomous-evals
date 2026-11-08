import {describe,it,expect} from 'vitest';
import {buildCompanyProvisionReceiptExport,compileCompanyProvisionReceipts, type ProvisionStageResult} from './naive-provision-receipts';
import {buildCompanyProvisionPlan,type CompanyProvisionPlanOptions} from '../packages/core/src/agents/company-provision-plan';
import {COMPANY_ROLE_DEFINITIONS} from '../packages/core/src/agents/company-roles';
const id=(prefix:string,n:number)=>`${prefix}_${String(n).padStart(26,'0')}`;
function fixture() {
 const options:CompanyProvisionPlanOptions={stage:'resources',revision:'pilot',createRevisionAgents:true,internalMcpUrl:'https://example.com/internal',credentialFiles:{},schedules:{}};
 for(const role of Object.keys(COMPANY_ROLE_DEFINITIONS) as Array<keyof typeof COMPANY_ROLE_DEFINITIONS>) {
  options.credentialFiles![role]=`/private/${role}`;
  options.schedules![role]={cron:'0 7 * * *',timezone:'UTC',inputTemplate:'Dry run',onIdleUrl:'https://example.com/secret-callback'};
 }
 return options;
}
function results(options:CompanyProvisionPlanOptions) {
 const plan=buildCompanyProvisionPlan(options);
 const rows=plan.operations.map((op,i)=>({kind:op.kind,name:op.kind==='agent'?op.body.name:op.kind==='skill'?op.body.slug:op.kind==='outcome'?op.body.name:op.kind==='vault'?op.body.display_name:op.kind==='credential'?op.body.key:op.name,status:'existing',receipt:{id:id(({skill:'skl',outcome:'ocm',agent:'agt',vault:'vlt',credential:'vcr',deployment:'dep'})[op.kind],op.kind==='agent'&&options.stage==='coordinator'?99:i),...(['agent','skill'].includes(op.kind)?{version:1}:{})}})) as ProvisionStageResult[];
 return {plan,rows};
}
describe('private staged roster receipts',()=>{
 it('progresses all five stages with exact pinned coordinator and disabled deployments',()=>{
  const options=fixture();
  for(const stage of ['resources','agents','coordinator','credentials','deployments'] as const) {
   options.stage=stage; const {plan,rows}=results(options);
   options.receipts=compileCompanyProvisionReceipts(options,plan,rows);
   if(stage==='deployments') expect(plan.operations.every(op=>op.kind==='deployment'&&op.body.enabled===false)).toBe(true);
  }
  expect(Object.keys(options.receipts!.agents!)).toHaveLength(15);
  expect(Object.keys(options.receipts!.credentials!)).toHaveLength(7);
  expect(JSON.stringify(options.receipts)).not.toMatch(/private|secret-callback|valueFile|inputTemplate/);
 });
 it.each(['missing','truncated','reordered','duplicate','version','unknown','changedplan','changedoptions','extraresult'] as const)('refuses %s evidence',mode=>{
  const options=fixture(),{plan,rows}=results(options);
  if(mode==='missing')rows[0]!.status='missing';
  if(mode==='truncated')rows.pop();
  if(mode==='reordered')[rows[0],rows[1]]=[rows[1]!,rows[0]!];
  if(mode==='duplicate')rows[1]!.receipt!.id=rows[0]!.receipt!.id;
  if(mode==='version')delete rows[0]!.receipt!.version;
  if(mode==='unknown')(rows[0] as any).secret='no';
  if(mode==='changedplan')(plan.operations[0]!.body as any).content='changed';
  if(mode==='changedoptions')options.revision='other';
  if(mode==='extraresult')rows.push(rows[0]!);
  expect(()=>compileCompanyProvisionReceipts(options,plan,rows)).toThrow();
 });
 it('rejects coordinator identity aliasing a retained member',()=>{
  const options=fixture();
  for(const stage of ['resources','agents'] as const) {
   options.stage=stage; const {plan,rows}=results(options);
   options.receipts=compileCompanyProvisionReceipts(options,plan,rows);
  }
  options.stage='coordinator';const {plan,rows}=results(options);
  rows[0]!.receipt!.id=options.receipts!.agents!.commercial!.id;
  expect(()=>compileCompanyProvisionReceipts(options,plan,rows)).toThrow();
 });
 it('rejects conflicts and secret-bearing or foreign prior metadata',()=>{
  const options=fixture(),{plan,rows}=results(options);
  const prior=compileCompanyProvisionReceipts(options,plan,rows);
  for(const mutate of [(r:any)=>r.skills['se-house-rules'].id=id('skl',99),(r:any)=>r.credentials={unknown:{value:'secret'}},(r:any)=>r.skills['se-house-rules'].value='secret',(r:any)=>r.outcomes.foreign={id:id('ocm',99)}]) {
   options.receipts=structuredClone(prior);mutate(options.receipts);
   expect(()=>compileCompanyProvisionReceipts(options,plan,rows)).toThrow();
  }
 });
 it('exports all terminal deployment identities without operation bodies or private input paths',()=>{
  const options=fixture();
  for(const stage of ['resources','agents','coordinator','credentials'] as const){options.stage=stage;const {plan,rows}=results(options);options.receipts=compileCompanyProvisionReceipts(options,plan,rows);}
  options.stage='deployments';const {plan,rows}=results(options);const exported=buildCompanyProvisionReceiptExport(options,plan,rows);
  expect(exported.schemaVersion).toBe('company_provision_receipts.v1');expect(exported.resources).toHaveLength(5);
  expect(exported.resources.map(r=>r.id)).toEqual(rows.map(r=>r.receipt!.id));
  expect(exported.receipts).toEqual(options.receipts);
  expect(JSON.stringify(exported)).not.toMatch(/private|secret-callback|valueFile|inputTemplate|on_idle/);
  rows[0]!.status='missing';expect(()=>buildCompanyProvisionReceiptExport(options,plan,rows)).toThrow();
 });

});
