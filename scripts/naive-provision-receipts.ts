/** Retained attestation evidence, not fresh provider authority. Never exports operation bodies or secret material. */
import { buildCompanyProvisionPlan, type CompanyProvisionPlanOptions, type CompanyProvisionPlan, type CompanyProvisionReceipts } from '../packages/core/src/agents/company-provision-plan';
import { COMPANY_SKILLS, COMPANY_OUTCOMES } from '../packages/core/src/agents/company-resources';
import { COMPANY_ROLE_DEFINITIONS, type CompanyRole } from '../packages/core/src/agents/company-roles';
import { configFingerprint, type ProvisionReceipt, type ProvisionResourceKind } from '../packages/core/src/agents/naive-provisioning';
export interface ProvisionStageResult { kind: ProvisionResourceKind; name: string; status: 'existing' | 'created' | 'missing'; receipt?: ProvisionReceipt }
const fail = (): never => { throw Error('Provision receipt evidence invalid or incomplete'); };
const object = (v: unknown): Record<string, any> => { if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(); return v as Record<string, any>; };
const keys = (v: unknown, allowed: string[]) => { const r=object(v); if(Object.keys(r).some(k=>!allowed.includes(k))) fail(); return r; };
const roles=Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
function priorReceipts(input: CompanyProvisionReceipts | undefined): CompanyProvisionReceipts {
  const value=structuredClone(input ?? {});
  keys(value,['skills','outcomes','vaults','agents','credentials']);
  for(const [category, entries] of Object.entries(value)) {
    const rows=object(entries);
    for(const [name,row] of Object.entries(rows)) {
      const fields=category==='skills'?['id','version','reference','sha256']:category==='outcomes'?['id']:category==='agents'?['id','version','name','configurationFingerprint']:category==='vaults'?['id','name']:['id','agentId','vaultId','mcpUrl'];
      const r=keys(row,fields); if(fields.some(f=>r[f]===undefined)) fail();
      if(['agents','vaults','credentials'].includes(category) && !roles.includes(name as CompanyRole)) fail();
      const prefix=({skills:'skl',outcomes:'ocm',agents:'agt',vaults:'vlt',credentials:'vcr'} as Record<string,string>)[category];
      if(typeof r.id!=='string'||!new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`).test(r.id)) fail();
      for(const f of fields.filter(f=>f!=='version')) if(typeof r[f]!=='string'||!r[f]) fail();
      if(fields.includes('version')&&(!Number.isSafeInteger(r.version)||r.version<=0)) fail();
      if(category==='agents'&&!/^[a-f0-9]{64}$/.test(r.configurationFingerprint)) fail();
      if(category==='skills'&&!/^[a-f0-9]{64}$/.test(r.sha256)) fail();
    }
  }
  const seen=new Set<string>();
  for(const entries of Object.values(value)) for(const row of Object.values(entries as Record<string, any>)) {
    if(seen.has(row.id)) fail(); seen.add(row.id);
  }
  return value;
}
/** Regenerate the exact authorized offline plan before deriving any receipt metadata. */
export function validateCompanyProvisionReceiptPlan(options: CompanyProvisionPlanOptions, plan: CompanyProvisionPlan): CompanyProvisionReceipts {
  const expected=buildCompanyProvisionPlan(options);
  if(configFingerprint(expected)!==configFingerprint(plan)) fail();
  const receipts=priorReceipts(options.receipts);
  for(const [slug,r] of Object.entries(receipts.skills ?? {})) {
    const skill=COMPANY_SKILLS.find(s=>s.slug===slug); if(!skill||r.sha256!==skill.sha256||r.reference!==`${slug}@${r.version}`) fail();
  }
  for(const name of Object.keys(receipts.outcomes ?? {})) if(!COMPANY_OUTCOMES.some(o=>o.name===name)) fail();
  if(Object.keys(receipts.agents ?? {}).length) {
    buildCompanyProvisionPlan({...options,stage:'agents',receipts});
    if(receipts.agents?.planner) buildCompanyProvisionPlan({...options,stage:'coordinator',receipts});
  }
  for(const [role,r] of Object.entries(receipts.vaults ?? {})) if(r.name!==`se-${role.replaceAll('_','-')}-${options.revision}`) fail();
  for(const [role,r] of Object.entries(receipts.credentials ?? {})) if(r.agentId!==receipts.agents?.[role as CompanyRole]?.id||r.vaultId!==receipts.vaults?.[role as CompanyRole]?.id||r.mcpUrl!==new URL(options.internalMcpUrl!).href) fail();
  return receipts;
}
export function compileCompanyProvisionReceipts(options: CompanyProvisionPlanOptions, plan: CompanyProvisionPlan, results: readonly ProvisionStageResult[]): CompanyProvisionReceipts {
  const receipts=validateCompanyProvisionReceiptPlan(options,plan);
  const expected=buildCompanyProvisionPlan(options);
  if(results.length!==expected.operations.length) fail();
  const identities=new Set<string>();
  function merge(category: keyof CompanyProvisionReceipts, name: string, row: Record<string, unknown>) {
    const map=(receipts[category] ??= {} as any) as Record<string, any>;
    if(map[name] && configFingerprint(map[name])!==configFingerprint(row)) fail();
    map[name]=row;
  }
  expected.operations.forEach((op,index)=>{
    const result=keys(results[index],['kind','name','status','receipt']) as unknown as ProvisionStageResult;
    const name=op.kind==='agent'?op.body.name:op.kind==='skill'?op.body.slug:op.kind==='outcome'?op.body.name:op.kind==='vault'?op.body.display_name:op.kind==='credential'?op.body.key:op.name;
    if(result.kind!==op.kind||result.name!==name||!['existing','created'].includes(result.status)) fail();
    const r=keys(result.receipt,['id','version']);
    const prefix=({skill:'skl',outcome:'ocm',agent:'agt',vault:'vlt',credential:'vcr',deployment:'dep'} as const)[op.kind];
    if(typeof r.id!=='string'||!new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`).test(r.id)||identities.has(r.id)) fail(); identities.add(r.id);
    if(op.kind==='skill'||op.kind==='agent') {if(!Number.isSafeInteger(r.version)||r.version<=0) fail();} else if(r.version!==undefined) fail();
    if(op.kind==='skill') merge('skills',op.body.slug,{id:r.id,version:r.version,reference:`${op.body.slug}@${r.version}`,sha256:op.body.sha256});
    else if(op.kind==='outcome') merge('outcomes',op.body.name,{id:r.id});
    else if(op.kind==='agent') {
      const role=op.body.metadata.ae_role as CompanyRole;
      if(!roles.includes(role)||op.pin&&(op.pin.id!==r.id||op.pin.version!==r.version)) fail();
      merge('agents',role,{id:r.id,version:r.version,name:op.body.name,configurationFingerprint:configFingerprint(op.body)});
    } else if(op.kind==='vault') {
      const role=roles.find(role=>`se-${role.replaceAll('_','-')}-${options.revision}`===op.body.display_name); if(!role) return fail();
      merge('vaults',role,{id:r.id,name:op.body.display_name});
    } else if(op.kind==='credential') {
      const role=roles.find(role=>receipts.agents?.[role]?.id===op.body.agent_id); if(!role) return fail();
      merge('credentials',role,{id:r.id,agentId:op.body.agent_id,vaultId:op.vaultId,mcpUrl:op.body.mcp_server_url});
    }
  });
  // Never return options, operation bodies, file paths, callbacks or credential values.
  return priorReceipts(receipts);
}

/** Persist terminal-stage identities too; they are not dependencies of a later roster stage. */
export function buildCompanyProvisionReceiptExport(options: CompanyProvisionPlanOptions, plan: CompanyProvisionPlan, results: readonly ProvisionStageResult[]) {
  const receipts = compileCompanyProvisionReceipts(options, plan, results);
  return {
    schemaVersion: 'company_provision_receipts.v1' as const,
    evidence: 'retained_attestation_not_fresh_authority' as const,
    stage: plan.stage,
    planFingerprint: configFingerprint(plan),
    receipts,
    resources: results.map(result => ({ kind: result.kind, name: result.name, status: result.status,
      id: result.receipt!.id, ...(result.receipt!.version === undefined ? {} : { version: result.receipt!.version }) })),
  };
}
