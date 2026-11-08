import {execFileSync as exec} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,renameSync,mkdtempSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {stageFinal,pins,root} from '../track-b-final-composition/stage.mjs';
export {root,pins};
const here=dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const comparison='docs/workflow-comparison-integration/app/004-rich-comparison.patch';
const resumption='docs/workflow-resumption-integration/resumption.patch';
const overlap='apps/web/src/workflows/steps/rich-evaluation.ts';
export function stageExtended(){
 const integrity=JSON.parse(readFileSync(join(here,'INTEGRITY.json')));
 if(integrity.parent!=='40014f4cf0c08bc8c6986b4a40aa28a53695172c'||JSON.stringify(integrity.pins)!==JSON.stringify(pins))throw Error('Extension pins drift');
 for(const [p,h] of Object.entries(integrity.sha256))if(hash(readFileSync(join(root,p)))!==h)throw Error('Extension input changed: '+p);
 const result=stageFinal(),{stage}=result;
 for(const [p,flags] of [[comparison,[]],[resumption,['--exclude='+overlap]]]){
  exec('git',['apply','--check',...flags,join(root,p)],{cwd:stage});
  exec('git',['apply',...flags,join(root,p)],{cwd:stage});
 }
 // Match final app's explicit directory-entrypoint imports; preserve module behavior.
 for(const [path,names] of [
  ['apps/web/src/server/comparison-production.ts',['evals/calendar-integration','simulator/workflow']],
  ['apps/web/src/server/rich-comparison.ts',['evals/text','evals/calendar-integration']]
 ]){
  let source=readFileSync(join(stage,path),'utf8');
  for(const name of names){const before="'@ae/core/"+name+"'";if(!source.includes(before))throw Error('Comparison import drift: '+before);source=source.replaceAll(before,"'@ae/core/"+name+"/index'");}
  writeFileSync(join(stage,path),source);
 }
 // Reproduce the merge from the exact post-comparison final source. No conflict markers or forced hunks.
 const ours=mkdtempSync(join(tmpdir(),'extension-merge-'));
 writeFileSync(join(ours,'ours.ts'),readFileSync(join(stage,overlap)));
 const merged=exec('git',['merge-file','-p',join(ours,'ours.ts'),join(root,'docs/complete-workflow-integration/source',overlap),join(root,'docs/workflow-resumption-integration/source',overlap)],{maxBuffer:4*1024*1024});
 if(!merged.equals(readFileSync(join(here,'source/rich-evaluation.ts'))))throw Error('Reviewed merged source differs from reproduced merge');
 writeFileSync(join(stage,overlap),merged);
 const manifest=JSON.parse(readFileSync(join(stage,'owner-migrations/manifest.json')));
 for(const [old,name,id,transactionOwner,after] of [
  ['004-rich-comparison','006-rich-comparison','app.rich-comparison.006','runner',['app.workflow-packs.005']],
  ['004-workflow-resumption','007-workflow-resumption','app.workflow-resumption.007','artifact',['app.rich-comparison.006','app.workflow-data.003']]
 ]){
  const sourcePath=`apps/web/migrations/${name}.sql`,canonicalPath=`owner-migrations/${id}.sql`;
  if(manifest.application.some(e=>e.id===id))throw Error('Duplicate migration '+id);
  renameSync(join(stage,`apps/web/migrations/${old}.sql`),join(stage,sourcePath));
  const bytes=readFileSync(join(stage,sourcePath)),sql=bytes.toString();
  if(transactionOwner==='artifact'&&(!/^BEGIN;/i.test(sql.trim())||!/COMMIT;\s*$/i.test(sql)))throw Error('Resumption transaction contract drift');
  if(transactionOwner==='runner'&&/^\s*BEGIN;/i.test(sql))throw Error('Comparison transaction contract drift');
  writeFileSync(join(stage,canonicalPath),bytes);
  manifest.application.push({id,sourcePath,sourceOrigin:'stage',canonicalPath,sha256:hash(bytes),transactionOwner,after,database:'application',historicalSourcePath:`apps/web/migrations/${old}.sql`});
 }
 const seen=new Set();for(const e of manifest.application){if(seen.has(e.id)||e.after.some(p=>!seen.has(p)))throw Error('Migration identity/order failure: '+e.id);seen.add(e.id);}
 manifest.migrationRenames={...manifest.migrationRenames,'apps/web/migrations/004-rich-comparison.sql':'apps/web/migrations/006-rich-comparison.sql','apps/web/migrations/004-workflow-resumption.sql':'apps/web/migrations/007-workflow-resumption.sql'};
 writeFileSync(join(stage,'owner-migrations/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 // Refresh final metadata and inventory after all extensions; exclude the two self-describing outputs.
 const applicationOrder=[...result.applicationOrder,'apply comparison, apply resumption excluding reproduced reviewed rich step, canonicalize migrations 006/007'];
 const combined={...result,migrations:manifest,applicationOrder,extensions:{comparison,resumption,mergedSource:'docs/track-b-release-extensions/source/rich-evaluation.ts'},liveRunPerformed:false};
 delete combined.applicationInventorySha256;delete combined.applicationFileCount;
 const inventory={};function walk(dir,p=''){for(const e of readdirSync(dir,{withFileTypes:true})){const k=p?p+'/'+e.name:e.name;if(e.isDirectory())walk(join(dir,e.name),k);else if(e.isFile()&&!['APPLICATION-SHA256.json','FINAL-COMPOSITION.json'].includes(k))inventory[k]=hash(readFileSync(join(dir,e.name)));}}
 walk(stage);writeFileSync(join(stage,'APPLICATION-SHA256.json'),JSON.stringify(inventory,null,2)+'\n');
 combined.applicationFileCount=Object.keys(inventory).length;combined.applicationInventorySha256=hash(readFileSync(join(stage,'APPLICATION-SHA256.json')));
 writeFileSync(join(stage,'FINAL-COMPOSITION.json'),JSON.stringify(combined,null,2)+'\n');
 return combined;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageExtended(),null,2));
