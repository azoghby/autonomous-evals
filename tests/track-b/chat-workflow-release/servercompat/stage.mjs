import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
export function stageSeries({corrected=false}={}) {
 const series=JSON.parse(readFileSync(join(root,'docs/workflow-integration/SERIES.json'),'utf8'));
 const stage=mkdtempSync(join(tmpdir(),'chat-workflow-servercompat-'));
 const archive=(ref,paths=[])=>execFileSync('tar',['-x','-C',stage],{input:execFileSync('git',['archive',ref,...paths],{cwd:root,maxBuffer:128*1024*1024})});
 const apply=p=>{execFileSync('git',['apply','--check',join(root,p)],{cwd:stage});execFileSync('git',['apply',join(root,p)],{cwd:stage});};
 archive(series.trackA);
 series.beforeCorePatches.forEach(apply);
 archive('48519bf',series.coreOverlay);
 series.patches.forEach(apply);
 if(corrected)apply('docs/chat-workflow-release/servercompat/0001-current-core-server.patch');
 return stage;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(stageSeries({corrected:process.argv.includes('--corrected')}));
