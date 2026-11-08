/** Operator-only. Offline plan by default; --inspect performs bounded read-only discovery. */
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildAgentOperation, buildPausedDeploymentOperation, provisionResources, type ProvisionJournal, type ProvisionIntent } from "../packages/core/src/agents/naive-provisioning";
import { buildSkillOperation, buildOutcomeOperation, buildVaultOperation, buildCredentialOperation } from "../packages/core/src/agents/naive-resources";

import { COMPANY_SKILLS, COMPANY_OUTCOMES } from "../packages/core/src/agents/company-resources";
import { COMPANY_ROLE_DEFINITIONS } from "../packages/core/src/agents/company-roles";

async function main() {
  const args=process.argv.slice(2);
  if(args.length===1 && args[0]==='--resource-plan') {process.stdout.write(JSON.stringify({operations:[...COMPANY_SKILLS.map(body=>({kind:'skill',body})),...COMPANY_OUTCOMES.map(body=>({kind:'outcome',body}))]},null,2)+'\n');return;}
  const apply=args[0]==='--apply' || args[0]==='--check';
  if(apply) {
    if(args.length!==3)throw Error('usage_apply_plan_journal');
    await applyPlan(args[1]!,args[2]!,args[0]==='--check');return;
  }
  if(args.some(a=>!['--dry-run','--inspect'].includes(a)) || args.length>1)throw Error("invalid_arguments");
  const definitions=Object.values(COMPANY_ROLE_DEFINITIONS);
  if(!args.includes('--inspect')) {
    process.stdout.write(JSON.stringify({mode:"offline_plan",agents:definitions.map(d=>({name:d.agentName,env:d.env})),skills:[...new Set(definitions.flatMap(d=>d.skillNames))],outcomes:definitions.flatMap(d=>d.outcomeName?[d.outcomeName]:[]),deployments:definitions.filter(d=>d.deployment).map(d=>({role:d.role,enabled:false,scheduleConfigured:!!d.deployment?.cron})),applyReady:false,blockers:["attested skill pins","per-role vault credentials and internal MCP authorization","operator schedules for Mara/Pax/Otto","owner-approved immutable migration of existing role names"]},null,2)+'\n');
    return;
  }
  const apiKey=process.env.NAIVE_API_KEY_FILE ? (await readFile(process.env.NAIVE_API_KEY_FILE,'utf8')).trim() : process.env.NAIVE_API_KEY;
  if(!apiKey)throw Error("credential_required");
  // Fixed official origin: never forward a supplied private key to an arbitrary URL.
  const { createClient } = await import('@usenaive-sdk/managed-agents');
  const client=createClient({apiKey,baseUrl:'https://api.vetta.sh',fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(30_000)})});
  const rows:Array<{id:string;version:number;role:string}>=[];const seen=new Set<string>();const cursors=new Set<string>();let after:string|undefined;let complete=false;
  for(let i=0;i<20;i++) {
    const page=await client.agents.list({limit:100,after});
    if(page.data.length>100 || typeof page.has_more!=='boolean' || (page.has_more ? !page.next_cursor : page.next_cursor!==null))throw Error('incomplete_listing');
    for(const a of page.data){if(seen.has(a.id))throw Error('incomplete_listing');seen.add(a.id);const role=definitions.find(d=>d.agentName===a.name);if(role)rows.push({id:a.id,version:a.current_version,role:role.role});}
    if(!page.has_more){complete=true;break;}if(cursors.has(page.next_cursor!))throw Error('incomplete_listing');cursors.add(page.next_cursor!);after=page.next_cursor!;
  }
  if(!complete)throw Error('incomplete_listing');
  process.stdout.write(JSON.stringify({mode:'read_only_inventory',agents:rows,configurationAttested:false},null,2)+'\n');
}
async function applyPlan(planPath:string,journalDir:string,dryRun=false) {
  const plan=JSON.parse(await readFile(planPath,'utf8')) as {operations:Array<{kind:string;name?:string;body:any;pin?:any;vaultId?:string;valueFile?:string;trusted?:any}>};
  if(!Array.isArray(plan.operations) || !plan.operations.length)throw Error();
  const apiKey=process.env.NAIVE_API_KEY_FILE ? (await readFile(process.env.NAIVE_API_KEY_FILE,'utf8')).trim() : process.env.NAIVE_API_KEY;
  if(!apiKey)throw Error();
  const { createClient } = await import('@usenaive-sdk/managed-agents');
  const factory=(key?:string)=>createClient({apiKey,baseUrl:'https://api.vetta.sh',idempotencyKey:()=>key??randomUUID(),fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(30_000)})});
  const operations=[];
  for(const item of plan.operations) {
    switch(item.kind) {
      case 'agent': operations.push(buildAgentOperation(factory,item.body,item.pin));break;
      case 'deployment': operations.push(buildPausedDeploymentOperation(factory,item.name!,item.body));break;
      case 'skill': operations.push(buildSkillOperation(factory,item.body));break;
      case 'outcome': operations.push(buildOutcomeOperation(factory,item.body));break;
      case 'vault': operations.push(buildVaultOperation(factory,item.body));break;
      case 'credential': {
        if(!item.valueFile || item.body.value!==undefined)throw Error();
        let trusted=item.trusted;
        if(!trusted && /^[a-z][a-z0-9_-]{0,79}$/.test(item.body.key)) {
          try { const prior=JSON.parse(await readFile(join(journalDir,`naive-provision_credential_${item.body.key}.json`),'utf8')) as ProvisionIntent;
            if(prior.state==='complete' && prior.receipt)trusted={id:prior.receipt.id,fingerprint:prior.fingerprint};
          } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
        }
        operations.push(buildCredentialOperation(factory,item.vaultId!,{...item.body,value:(await readFile(item.valueFile,'utf8')).trim()},trusted));break;
      }
      default:throw Error();
    }
  }
  if(!dryRun)await mkdir(journalDir,{recursive:true,mode:0o700});
  const filename=(key:string)=>join(journalDir,key.replaceAll(':','_')+'.json');
  const persist=async(path:string,value:unknown)=>{const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}};
  const syncDirectory=async()=>{const d=await open(journalDir,'r');try{await d.sync();}finally{await d.close();}};
  const journal:ProvisionJournal={
    async read(key){try{return JSON.parse(await readFile(filename(key),"utf8")) as ProvisionIntent;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}},
    async claim(intent){try{await persist(filename(intent.key),intent);await syncDirectory();return {inserted:true,intent};}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return {inserted:false,intent:JSON.parse(await readFile(filename(intent.key),'utf8')) as ProvisionIntent};}},
    async complete(key,fingerprint,receipt){const prior=JSON.parse(await readFile(filename(key),'utf8')) as ProvisionIntent;if(prior.fingerprint!==fingerprint)throw Error();const temp=filename(key)+'.'+randomUUID();await persist(temp,{key,fingerprint,state:'complete',receipt});await rename(temp,filename(key));await syncDirectory();},
  };
  const result=await provisionResources(operations,journal,{dryRun});
  process.stdout.write(JSON.stringify(result.map(r=>({kind:r.kind,status:r.status,...r.receipt})),null,2)+'\n');
}
main().catch(()=>{process.stderr.write('Naive provisioning blocked; inspect local prerequisites or reconcile provider state.\n');process.exitCode=1;});
