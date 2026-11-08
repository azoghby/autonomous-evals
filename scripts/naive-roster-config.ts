/** Strict offline roster input and reproducible retained receipt chain. No I/O. */
import { COMPANY_ROLE_DEFINITIONS, type CompanyRole } from '../packages/core/src/agents/company-roles';
import { buildCompanyProvisionPlan, type CompanyProvisionPlanOptions, type CompanyProvisionReceipts, type CompanyProvisionStage } from '../packages/core/src/agents/company-provision-plan';
import { configFingerprint } from '../packages/core/src/agents/naive-provisioning';
import { buildCompanyProvisionReceiptExport, type ProvisionStageResult } from './naive-provision-receipts';
const stages: readonly CompanyProvisionStage[] = ['resources','agents','coordinator','credentials','deployments'];
const roles = Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
const mcpRoles = roles.filter(role => Object.keys(COMPANY_ROLE_DEFINITIONS[role].tools).some(tool => tool.startsWith('se_internal.')));
const deploymentRoles = roles.filter(role => COMPANY_ROLE_DEFINITIONS[role].deployment);
type Schedule = {cron:string;timezone:string;inputTemplate:string;budgetMicroUsd?:number};
export interface RosterRolloutSpec {
 schemaVersion:'naive_roster_rollout.v1'; createRevisionAgents:true; revision:string; model:string;
 appOrigin:string; internalMcpUrl:string; onIdleUrl:string;
 credentialFiles:Partial<Record<CompanyRole,string>>; schedules:Partial<Record<CompanyRole,Schedule>>;
}
export type RosterReceiptExport = ReturnType<typeof buildCompanyProvisionReceiptExport>;
const fail = (reason:string):never => {throw new Error(`Roster rollout invalid: ${reason}`);};
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))return fail('expected object');return v as Record<string,unknown>;}
function jsonValue(value:unknown):void {
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(Array.isArray(value)){for(const item of value)jsonValue(item);return;}
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===Object.keys(value).length){for(const item of Object.values(value))jsonValue(item);return;}
 fail('non-JSON fields');
}
function exact(v:unknown,required:readonly string[],optional:readonly string[]=[]){const r=record(v);if(required.some(k=>!Object.hasOwn(r,k))||Object.keys(r).some(k=>![...required,...optional].includes(k)))fail('unexpected or missing fields');return r;}
function clean(v:unknown):v is string{return typeof v==='string'&&v.length>0&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);}
function cronValid(value:string){
 const fields=value.split(' '),bounds=[[0,59],[0,23],[1,31],[1,12],[0,7]];
 if(fields.length!==5)return false;
 return fields.every((field,i)=>field.split(',').every(part=>{
  const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);if(!match)return false;
  const [min,max]=bounds[i]!;if(match[2]&&(+match[2]<1||+match[2]>max-min+1))return false;
  if(match[1]==='*')return true;
  const [start,end]=match[1]!.split('-').map(Number);return start!>=min&&start!<=max&&(end===undefined||end>=start!&&end<=max);
 }));
}
export function parseRosterRolloutSpec(raw:unknown):RosterRolloutSpec{
 jsonValue(raw);
 const r=exact(raw,['schemaVersion','createRevisionAgents','revision','model','appOrigin','internalMcpUrl','onIdleUrl','credentialFiles','schedules']);
 if(r.schemaVersion!=='naive_roster_rollout.v1'||r.createRevisionAgents!==true)fail('unsupported schema or missing revision opt-in');
 if(typeof r.revision!=='string'||!/^[a-z][a-z0-9-]{0,19}$/.test(r.revision))fail('revision');
 if(!clean(r.model))fail('model required');
 if(!clean(r.appOrigin))fail('application origin');
 try{const u=new URL(r.appOrigin as string);if(u.protocol!=='https:'||u.origin!==r.appOrigin||u.username||u.password||!u.hostname.includes('.'))fail('application origin');}catch{fail('application origin');}
 if(r.internalMcpUrl!==`${r.appOrigin}/api/mcp/internal/mcp`)fail('internal MCP endpoint');
 if(typeof r.onIdleUrl!=='string'||!r.onIdleUrl.startsWith(`${r.appOrigin}/api/naive/idle/`)||!/^[A-Za-z0-9_-]+$/.test(r.onIdleUrl.slice(`${r.appOrigin}/api/naive/idle/`.length)))fail('idle callback');
 const files=exact(r.credentialFiles,mcpRoles),seen=new Set<string>();
 for(const role of mcpRoles){const path=files[role];if(!clean(path)||!path.startsWith('/')||seen.has(path))fail('credential file paths');seen.add(path as string);}
 const schedules=exact(r.schedules,deploymentRoles);
 for(const role of deploymentRoles){const s=exact(schedules[role],['cron','timezone','inputTemplate'],['budgetMicroUsd']);
  if(!clean(s.cron)||!cronValid(s.cron))fail('schedule cron');
  if(!clean(s.timezone))fail('schedule timezone');try{new Intl.DateTimeFormat('en',{timeZone:s.timezone as string});}catch{fail('schedule timezone');}
  if(!clean(s.inputTemplate))fail('schedule input template');
  if(Object.hasOwn(s,'budgetMicroUsd')&&(!Number.isSafeInteger(s.budgetMicroUsd)||Number(s.budgetMicroUsd)<=0||Number(s.budgetMicroUsd)>COMPANY_ROLE_DEFINITIONS[role].maxTaskMicroUsd))fail('schedule budget');
 }
 return structuredClone(r) as unknown as RosterRolloutSpec;
}
function optionsFor(spec:RosterRolloutSpec,index:number,receipts:CompanyProvisionReceipts):CompanyProvisionPlanOptions{
 return {stage:stages[index]!,createRevisionAgents:true,revision:spec.revision,model:spec.model,internalMcpUrl:spec.internalMcpUrl,credentialFiles:structuredClone(spec.credentialFiles),schedules:Object.fromEntries(deploymentRoles.map(role=>[role,{...spec.schedules[role]!,onIdleUrl:spec.onIdleUrl}])),receipts:structuredClone(receipts)};
}
export function validateRosterReceiptChain(rawSpec:unknown,exports:readonly unknown[]){
 const spec=parseRosterRolloutSpec(rawSpec),rolloutFingerprint=configFingerprint(spec);
 if(!Array.isArray(exports)||exports.length>5)fail('receipt chain length');
 let receipts:CompanyProvisionReceipts={};const canonical:RosterReceiptExport[]=[];
 for(let index=0;index<exports.length;index++){
  try{
   jsonValue(exports[index]);
   const bundle=exact(exports[index],['schemaVersion','evidence','stage','planFingerprint','receipts','resources']);
   if(!Array.isArray(bundle.resources))fail('receipt resources');
   const options=optionsFor(spec,index,receipts),plan=buildCompanyProvisionPlan(options);
   const results:ProvisionStageResult[]=(bundle.resources as unknown[]).map(raw=>{const row=exact(raw,['kind','name','status','id'],['version']);return {kind:row.kind,name:row.name,status:row.status,receipt:{id:row.id,...(Object.hasOwn(row,'version')?{version:row.version}:{})}} as ProvisionStageResult;});
   const expected=buildCompanyProvisionReceiptExport(options,plan,results);
   if(configFingerprint(expected)!==configFingerprint(bundle))fail('receipt bundle mismatch');
   receipts=expected.receipts;canonical.push(expected);
  }catch{fail('receipt chain evidence');}
 }
 return {spec,receipts,exports:canonical,completedStages:canonical.length,rolloutFingerprint};
}
export function compileRosterStage(rawSpec:unknown,exports:readonly unknown[]){
 const chain=validateRosterReceiptChain(rawSpec,exports);if(chain.completedStages===5)fail('rollout already complete');
 const options=optionsFor(chain.spec,chain.completedStages,chain.receipts);
 return {options,plan:buildCompanyProvisionPlan(options),rolloutFingerprint:chain.rolloutFingerprint};
}
