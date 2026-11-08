import {execFileSync as exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageComplete} from '../complete-workflow-integration/stage.mjs';
import {applyCalendar} from './calendar/apply.mjs';
import {applyPack} from './pack/apply.mjs';
import {applyChat,writeMigrationManifest} from './chat/apply.mjs';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const pins={trackA:'530af32067279497161c22ab00006247851d9200',trackB:'687b5086e6bd204fe82809672c0511e2ee3e6f52',applicationBaseline:'f0068733ca49c37f40fd7de279325f21a4b5fbbb',historicalCore:'e61ad9719a1f7cfc844523cffbd72253dcdcb30b',acceptanceIntegration:'449c05df550afa0ac1f8b6030cc9fc8bbadbf52e'};
export function verifyIntegrity(){
 const manifest=JSON.parse(readFileSync(join(root,'docs/track-b-final-composition/INTEGRITY.json'),'utf8'));
 if(JSON.stringify(manifest.pins)!==JSON.stringify(pins))throw Error('Final immutable pins differ; inspect INTEGRITY.json');
 for(const [path,expected] of Object.entries(manifest.sha256))if(createHash('sha256').update(readFileSync(join(root,path))).digest('hex')!==expected)throw Error(`Final input changed: ${path}; restore pinned bytes or explicitly review and regenerate integrity`);
 for(const pin of Object.values(pins))exec('git',['cat-file','-e',`${pin}^{commit}`],{cwd:root});
}
export function stageFinal(){
 verifyIntegrity();
 const result=stageComplete(),{stage}=result;
 // Lift the historical composition to the two explicit local source heads.
 const paths=['agents','evals','judges','monitoring','reporting','simulator','targets'].map(p=>`packages/core/src/${p}`);
 for(const path of paths)rmSync(join(stage,path),{recursive:true,force:true});
 exec('tar',['-x','-C',stage],{input:exec('git',['archive',pins.trackB,...paths],{cwd:root,maxBuffer:128*1024*1024})});
 const delta=exec('git',['diff','--binary',pins.applicationBaseline,pins.trackA],{cwd:root,maxBuffer:32*1024*1024});
 exec('git',['apply','--check','-'],{cwd:stage,input:delta});exec('git',['apply','-'],{cwd:stage,input:delta});
 const chat=applyChat(stage),pack=applyPack(stage),calendar=applyCalendar(stage),migrations=writeMigrationManifest(stage);
 const remediationPath=join(stage,'apps/web/src/server/rich-remediation.ts');
 let remediationSource=readFileSync(remediationPath,'utf8');
 for(const name of ['evals/remediation','evals/remediation/accounting','evals/text']) {
  const old="'@ae/core/"+name+"'";
  if(!remediationSource.includes(old))throw Error('Remediation directory import drift: '+old);
  remediationSource=remediationSource.replaceAll(old,"'@ae/core/"+name+"/index'");
 }
 writeFileSync(remediationPath,remediationSource);
 const progressPatch=join(root,'docs/track-b-final-composition/cloned-progress-plan.patch');
 exec('git',['apply','--check',progressPatch],{cwd:stage});exec('git',['apply',progressPatch],{cwd:stage});
 const applicationOrder=['stageComplete historical archive and verified patches','replace seven core source trees from Track B pin','apply Track A baseline-to-current delta','apply six chat/build/package/Text patches','apply pack projection/execution and four merged sources','apply separately pinned Calendar controlled target','canonicalize SQL identities; generate owner-migrations in manifest order','correct explicit remediation /index imports and immutable cloned progress plan comparison'];
 // The fetched A delta is orthogonal to application composition. Prove every byte.
 const priorA='da92bedd68b230188e2499fdd8440ea23b2f1d6b';
 const latestAPaths=exec('git',['diff','--name-only',priorA,pins.trackA],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const p of latestAPaths)if(!readFileSync(join(stage,p)).equals(exec('git',['show',`${pins.trackA}:${p}`],{cwd:root})))throw Error('Latest Track A preservation mismatch: '+p);
 const inventory={};
 function walk(dir,relative=''){for(const entry of readdirSync(dir,{withFileTypes:true})){const p=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())walk(join(dir,entry.name),p);else if(entry.isFile())inventory[p]=createHash('sha256').update(readFileSync(join(dir,entry.name))).digest('hex');}}
 walk(stage);
 writeFileSync(join(stage,'APPLICATION-SHA256.json'),JSON.stringify(inventory,null,2)+'\n');
 const output={stage,pins,chat,pack,calendar,migrations,applicationOrder,latestAPreservedPaths:latestAPaths,applicationFileCount:Object.keys(inventory).length,applicationInventorySha256:createHash('sha256').update(readFileSync(join(stage,'APPLICATION-SHA256.json'))).digest('hex'),liveRunPerformed:false};
 writeFileSync(join(stage,'FINAL-COMPOSITION.json'),JSON.stringify(output,null,2)+'\n');
 return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageFinal(),null,2));
