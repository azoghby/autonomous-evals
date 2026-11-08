import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const calendarArtifactCommit='687b5086e6bd204fe82809672c0511e2ee3e6f52';
const here=dirname(fileURLToPath(import.meta.url));
export function applyCalendar(stage){
 const m=JSON.parse(readFileSync(join(here,'PATCH.json'))),patch=join(here,'0001-controlled-calendar-targets.patch');
 if(createHash('sha256').update(readFileSync(patch)).digest('hex')!==m.patchSha256)throw Error('Calendar patch pin changed');
 execFileSync('git',['apply','--check',patch],{cwd:stage});execFileSync('git',['apply',patch],{cwd:stage});
 for(const [p,h]of Object.entries(m.files))if(createHash('sha256').update(readFileSync(join(stage,p))).digest('hex')!==h)throw Error('Calendar source mismatch: '+p);
 return {commit:calendarArtifactCommit,origin:'internal_fixture',systemPrompt:m.systemPrompt,scenarioDigest:m.scenarioDigest,remotePromptAttestation:false,toolResultAuthenticity:'not_attested_independent_SQL_required',targetRequests:{text:24,calendar:8,totalBeforeReproductions:32},acceptance:'pending_owner_driver_and_deployment'};
}
/** Pure preflight for the separate owner driver, never dispatches. */
export function assertAcceptanceBudget({text=24,calendar=8,reproductions=0,pack=0,cap=32}={}){
 const counts=[text,calendar,reproductions,pack,cap];
 if(counts.some(n=>!Number.isSafeInteger(n)||n<0)||text+calendar+reproductions+pack>cap)throw Error('Target request plan exceeds approved cap before dispatch; reduce reviewed plan or obtain a separately approved cap. Text24 + Calendar8 exhausts target32; reproductions and packs require additional capacity.');
 return text+calendar+reproductions+pack;
}
