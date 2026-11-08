import {execFileSync as exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync as read,writeFileSync as write,readdirSync,renameSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {stageExtended,root,pins as historicalPins} from '../track-b-release-extensions/stage.mjs';
import {applyRemediation} from '../controlled-remediation-targets/stage.mjs';
export {root};
export const pins={...historicalPins,trackA:'aa94505fd535f5c0f586cc6325b49b71a1683761'};
const here=fileURLToPath(new URL('.',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
export function stageJudged(){
 const integrity=JSON.parse(read(join(here,'INTEGRITY.json')));
 for(const [p,h] of Object.entries(integrity.sha256))if(hash(read(join(root,p)))!==h)throw Error('Pinned input drift: '+p);
 const result=stageExtended(),{stage}=result;
 const apply=(p,flags=[])=>{for(const mode of [['--check'],[]])exec('git',['apply',...mode,...flags,join(root,p)],{cwd:stage});};
 const rich='apps/web/src/server/rich-services.ts';
 const original=read(join(stage,rich));
 const series=JSON.parse(read(join(root,'docs/workflow-rerun-integration/SERIES.json')));
 for(const [p,h] of Object.entries(series.preimageSha256)) {
  if(h===null){try{read(join(stage,p));throw Error('Expected absent: '+p);}catch(e){if(e.code!=='ENOENT')throw e;}}
  else if(hash(read(join(stage,p)))!==h)throw Error('Rerun preimage drift: '+p);
 }
 apply('docs/workflow-judging-integration/app/005-judging.patch');
 // The comparison import normalization is retained via three-way composition.
 const merge=(ours,base,theirs)=>{
  const dir=mkdtempSync(join(tmpdir(),'judged-merge-'));
  for(const [n,b] of [['ours',ours],['base',base],['theirs',theirs]])write(join(dir,n),b);
  return exec('git',['merge-file','-p',...['ours','base','theirs'].map(n=>join(dir,n))],{maxBuffer:8*1024*1024});
 };
 for(const p of ['apps/web/src/server/rich-comparison.ts','apps/web/src/server/comparison-production.ts']){
  write(join(stage,p),merge(read(join(stage,p)),read(join(root,'docs/workflow-comparison-integration/app/files',p)),read(join(root,'docs/workflow-judging-integration/app/files',p))));
 }
 const judged=read(join(stage,rich));
 apply('docs/workflow-rerun-integration/rerun.patch',['--exclude='+rich]);
 // Explicit conflict resolution: replay only the judging delta onto verified rerun authority.
 let merged=read(join(root,'docs/workflow-rerun-integration/source',rich),'utf8');
 const judgedText=judged.toString();
 merged=judgedText.slice(0,judgedText.indexOf("import 'server-only';"))+merged;
 merged=merged.replace('workflowRunId: string; rerun?', 'workflowRunId: string; judgeRuntime?: TrustedJudgeRuntime; rerun?');
 merged=merged.replace('  const initial = await canonical();',judgedText.slice(judgedText.indexOf('  const judgeRuntime ='),judgedText.indexOf('  const initial = await canonical();'))+'  const initial = await canonical();');
 merged=merged.replace('judge: null, knownSecrets:', 'judge, knownSecrets:').replace('canonical, text });','canonical, text, judge: remediationJudge });');
 // Separate bounded phase instances; injected acceptance runtime remains shared and lower-capped.
 merged=merged.replace('workflowJudgeRuntime();',"workflowJudgeRuntime(authority.rerun ? 'rerun' : 'baseline');");
 const blockStart=merged.indexOf('  const judge = createTrustedJudgeResolver('),blockEnd=merged.indexOf('  const initial = await canonical();');
 const block=merged.slice(blockStart,blockEnd);
 merged=merged.slice(0,blockEnd)+block.replace('const judge =','const remediationJudge =').replace('...judgeRuntime','...remediationRuntime').replace('await judgeRuntime.beforeDispatch(intent);',"await remediationRuntime.beforeDispatch(intent);").replace('  const remediationJudge =',"  const remediationRuntime = authority.judgeRuntime ?? workflowJudgeRuntime('remediation');\n  const remediationJudge =")+merged.slice(blockEnd);
 merged=merged.replace(' // Explicit unassessed rubric; no unreserved Gateway call.','');
 write(join(stage,rich),merged);
 let production=read(join(stage,'apps/web/src/server/comparison-production.ts'),'utf8').replace('workflowJudgeRuntime()',"workflowJudgeRuntime('comparison')");
 write(join(stage,'apps/web/src/server/comparison-production.ts'),production);
 let judgeSource=read(join(stage,'apps/web/src/server/rich-judge.ts'),'utf8');
 judgeSource=judgeSource.replace('export function workflowJudgeRuntime(): TrustedJudgeRuntime {', `export type WorkflowJudgePhase = 'baseline' | 'remediation' | 'rerun' | 'comparison';
/** Server-only phase plan; no HTTP/body choice. Missing plan refuses dispatch. Permanent
 * SQL claims and monetary reservations still fence every call across worker restarts.
 * This local ceiling never overrides acceptance's separate durable lower-cap meter. */
export function workflowJudgeRuntime(phase: WorkflowJudgePhase = 'baseline'): TrustedJudgeRuntime {
  let limit = 0;
  const raw = process.env.WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS;
  if (raw) {
    let plan: Record<string, unknown>;
    try { plan = JSON.parse(raw); } catch { return refuse(); }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || Object.keys(plan).some(k => !['baseline','remediation','rerun','comparison'].includes(k))) return refuse();
    const value = plan[phase];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 96) return refuse();
    limit = Number(value);
  }`);
 judgeSource=judgeSource.replace('++dispatched > 16','++dispatched > limit');
 write(join(stage,'apps/web/src/server/rich-judge.ts'),judgeSource);
 apply('docs/comparison-cost-delivery-fix/fix.patch');
 applyRemediation(stage);
 apply('docs/track-b-judged-release/track-a-refresh.patch');
 apply('docs/track-b-judged-release/core-report-snapshot.patch');
 const manifest=JSON.parse(read(join(stage,'owner-migrations/manifest.json')));
 const old='apps/web/migrations/006-workflow-finding-reruns.sql',sourcePath='apps/web/migrations/008-workflow-finding-reruns.sql';
 renameSync(join(stage,old),join(stage,sourcePath));
 const id='app.workflow-finding-reruns.008',canonicalPath='owner-migrations/'+id+'.sql',bytes=read(join(stage,sourcePath));
 if(hash(bytes)!=='9884992989f6aafb1861708ad426924651f172b90295fb13e8a78e06e1e688e7')throw Error('Rerun SQL changed');
 write(join(stage,canonicalPath),bytes);
 manifest.application.push({id,sourcePath,sourceOrigin:'stage',canonicalPath,sha256:hash(bytes),transactionOwner:'runner',database:'application',after:['app.workflow002','app.workflow-remediation.004','app.workflow-packs.005','app.workflow-resumption.007'],historicalSourcePath:old,historicalIdentityAliases:['app.workflow-finding-reruns.006'],identityReconciliationRequiredIfAliasApplied:true});
 manifest.migrationRenames[old]=sourcePath;
 manifest.identityAliases={...manifest.identityAliases,'app.workflow-finding-reruns.006':id,'app.workflow-comparison.006':'app.rich-comparison.006'};
 const seen=new Set();for(const e of manifest.application){if(seen.has(e.id)||e.after.some(p=>!seen.has(p)))throw Error('Migration order: '+e.id);seen.add(e.id);}
 write(join(stage,'owner-migrations/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 for(const p of ["apps/web/src/server/rich-services.ts", "apps/web/src/server/rich-judge.ts", "apps/web/src/server/rich-comparison.ts", "apps/web/src/server/comparison-production.ts", "packages/core/src/reporting/render.ts"])if(!read(join(stage,p)).equals(read(join(here,'source',p))))throw Error('Reviewed composed postimage differs: '+p);
 const inventory={};function walk(dir,p=''){for(const e of readdirSync(dir,{withFileTypes:true})){const k=p?p+'/'+e.name:e.name;if(e.isDirectory())walk(join(dir,e.name),k);else if(e.isFile()&&!['APPLICATION-SHA256.json','FINAL-COMPOSITION.json'].includes(k))inventory[k]=hash(read(join(dir,e.name)));}}
 walk(stage);write(join(stage,'APPLICATION-SHA256.json'),JSON.stringify(inventory,null,2)+'\n');
 const combined={...result,pins,historicalTrackAPin:historicalPins.trackA,migrations:manifest,applicationOrder:[...result.applicationOrder,'trusted judging + reviewed three-way rich-services delivered-owner rerun merge','central comparison cost delivery','controlled remediation fixture','canonical rerun proposed008'],applicationFileCount:Object.keys(inventory).length,applicationInventorySha256:hash(read(join(stage,'APPLICATION-SHA256.json'))),coreDeltas:[{commit:"8e648e6ba53cc9a104511b797c789593fd7d432d",patch:"docs/track-b-judged-release/core-report-snapshot.patch"}],liveRunPerformed:false,releaseAccepted:false};
 write(join(stage,'FINAL-COMPOSITION.json'),JSON.stringify(combined,null,2)+'\n');return combined;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageJudged(),null,2));
