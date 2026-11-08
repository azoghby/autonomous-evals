// Review runner: rebuilds the exact recorded company candidate in a fresh
// temporary directory, adds the parent's supplemental tests and this review's
// tests, and runs vitest offline. The parent's candidate directories are only
// read (after hash checks), never written.
//
//   node tests/track-b/current-company-review/run.mjs [--baseline] [vitest filters...]
//
// --baseline also runs the parent's 23 selected files (expect 164 passing).
// Env: COMPANY_REVIEW_CANDIDATE (default reproduced candidate),
// --typecheck runs strict tsc over the review tests (in the temp stage) first.
//      COMPANY_REVIEW_DEPS (default node_modules of the tested candidate).
import {readFileSync as read,writeFileSync as write,mkdirSync,mkdtempSync,existsSync,readdirSync,lstatSync,realpathSync,symlinkSync,cpSync} from 'node:fs';
import {join,dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const candidate=JSON.parse(read(join(root,'docs/current-company-composition/CANDIDATE.json')));
const source=resolve(process.env.COMPANY_REVIEW_CANDIDATE??'/private/tmp/track-b-company-reproduced-20261107');
const deps=resolve(process.env.COMPANY_REVIEW_DEPS??'/private/tmp/track-b-company-composed-y74pmmb8/node_modules');
const args=process.argv.slice(2);const baseline=args.includes('--baseline'),typecheck=args.includes('--typecheck');const filters=args.filter(a=>a!=='--baseline'&&a!=='--typecheck');

// 1. Hash-check every recorded file before reading anything else from the candidate.
const files=Object.entries(candidate.files);
for(const [p,v]of files){const b=read(join(source,p));if(b.length!==v.bytes||sha(b)!==v.sha256)throw Error('Candidate drift: '+p);}
const stage=mkdtempSync(join(tmpdir(),'company-payment-fixed-'));
for(const [p]of files){mkdirSync(dirname(join(stage,p)),{recursive:true});write(join(stage,p),read(join(source,p)));}
// Stage manifests (unrecorded; read by the parent's composition test).
for(const m of ['CURRENT-COMPOSITION.json','PAYMENT-COMPOSITION.json','COMPANY-COMPOSITION.json'])if(existsSync(join(source,m)))write(join(stage,m),read(join(source,m)));

// 2. Supplemental tests the parent ran that are not in the 2,041 recorded files.
// They come from this checkout; they must not overwrite a recorded file.
const parentDirs=['tests/track-b/autonomous-company','tests/track-b/autonomy-release-adoption','tests/track-b/autonomy-paid-app-integration','tests/track-b/current-autonomy-integration','tests/track-b/current-autonomy-calendar','tests/track-b/current-autonomy-payment-startup'];
const supplemental=[];
function copyTree(dir){const abs=join(root,dir);if(!existsSync(abs))return;for(const n of readdirSync(abs)){const rel=join(dir,n);const s=lstatSync(join(root,rel));if(n==='evidence'||n==='final-evidence'||n==='private-review-evidence'||n==='node_modules')continue;if(s.isDirectory())copyTree(rel);else if(s.isFile()){if(candidate.files[rel])continue;mkdirSync(dirname(join(stage,rel)),{recursive:true});const b=read(join(root,rel));write(join(stage,rel),b);supplemental.push({path:rel,sha256:sha(b)});}}}
// Fixture inputs the parent tests read from docs (DDL, bridge postimages).
for(const d of [...parentDirs,'docs/current-autonomy-payment-startup','docs/current-autonomy-integration/dependencies/owner-migrations'])copyTree(d);
copyTree('tests/track-b/current-company-review');
copyTree('tests/track-b/current-company-payment-fixes');

// Apply only hash-pinned owner corrections to the copied historical candidate.
const correctionRoot=join(root,'docs/current-company-payment-fixes');
const correction=JSON.parse(read(join(correctionRoot,'PIN.json')));
const patch=read(join(correctionRoot,'owner.patch'));
if(sha(patch)!==correction.patchSha256)throw Error('Correction patch drift');
for(const [p,v]of Object.entries(correction.paths))if(sha(read(join(stage,p)))!==v.before)throw Error('Correction preimage drift: '+p);
for(const a of [['apply','--check','-'],['apply','-']]){const r=spawnSync('git',a,{cwd:stage,input:patch,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
const payment=JSON.parse(read(join(stage,'PAYMENT-COMPOSITION.json')));
payment.reviewChanges??={};
for(const [p,v]of Object.entries(correction.paths)){
 if(sha(read(join(stage,p)))!==v.after)throw Error('Correction postimage drift: '+p);
 payment.reviewChanges[p]={sha256:v.after};
}
write(join(stage,'PAYMENT-COMPOSITION.json'),JSON.stringify(payment,null,2)+'\n');
if(sha(read(join(correctionRoot,'sql/002-payment-recovery.sql')))!==correction.sqlSha256)throw Error('Correction SQL drift');
const sql=join(stage,'docs/current-autonomy-payment-startup/sql/001-current-payment.sql');
write(sql,read(sql).toString()+'\n'+read(join(correctionRoot,'sql/002-payment-recovery.sql')));
// Existing bridge tests import its documented postimage; keep it exact to the
// applied source, and retain those tests rather than skipping the duplicate path.
const bridgeCopy=join(stage,'docs/current-autonomy-payment-startup/bridge/source/apps/web/src/server/current-payment.ts');
if(existsSync(bridgeCopy))write(bridgeCopy,read(join(stage,'apps/web/src/server/current-payment.ts')));
// Convert only assertions that deliberately pinned the reproduced wrong state.
const fixAssertions=(p,from,to)=>{const path=join(stage,p);const s=read(path).toString();if(!s.includes(from))throw Error('Regression preimage drift: '+p);write(path,s.replace(from,to));};
fixAssertions('tests/track-b/current-company-review/authorization-payment/findings.test.ts','expect(stuck).toBe(25); // root cause: revocation rows are never acknowledged','expect(stuck).toBe(0); // permanently revoked rows are acknowledged');
const control='tests/track-b/current-company-review/replay-verification/receipt-drain.characterization.test.ts';
fixAssertions(control,'expect(outcomes).toHaveLength(25)','expect(outcomes).toHaveLength(1)');
fixAssertions(control,".outcomes).toEqual([{jobId:j.id,checked:1}])",'.outcomes).toEqual([])');
fixAssertions(control,'expect(await f.undelivered()).toBe(1)','expect(await f.undelivered()).toBe(0)');
// 3. Dependencies: link every package from the tested candidate except the
// workspace self-link, which must point at this stage's core.
const nm=join(stage,'node_modules');mkdirSync(nm);
for(const n of readdirSync(deps)){
 const p=join(deps,n);
 if(n==='@ae'){mkdirSync(join(nm,'@ae'));symlinkSync(join(stage,'packages/core'),join(nm,'@ae/core'));continue;}
 symlinkSync(realpathSync(p),join(nm,n));
}
write(join(stage,'empty-server-only.mjs'),'export {};\n');
const guard=join(stage,'offline.cjs');cpSync(join(root,'tests/track-b/current-autonomy-integration/offline.cjs'),guard);
const include=['tests/track-b/current-company-review/**/*.test.ts','tests/track-b/current-company-payment-fixes/**/*.test.ts'];
if(baseline)include.push(...parentDirs.map(d=>d+'/**/*.test.ts'),'packages/core/src/evals/calendar-integration/**/*.test.ts');
write(join(stage,'review-vitest.config.mjs'),'export default '+JSON.stringify({resolve:{alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'empty-server-only.mjs')}},test:{include,maxWorkers:1,testTimeout:60000,hookTimeout:60000}})+';\n');
write(join(stage,'REVIEW-STAGE.json'),JSON.stringify({source,deps,candidateFiles:files.length,supplemental},null,2)+'\n');

// 4. Run offline with an allowlisted environment (no .env, no credentials).
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',NODE_OPTIONS:'--require='+JSON.stringify(guard),WORKFLOW_STAGE:stage,EXTENSION_STAGE:stage};
if(typecheck){
 write(join(stage,'tsconfig.review.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:['tests/track-b/current-company-review/**/*.ts','tests/track-b/current-company-payment-fixes/**/*.ts']}));
 const t=spawnSync(process.execPath,[join(nm,'typescript/bin/tsc'),'-p','tsconfig.review.json'],{cwd:stage,env,stdio:'inherit'});
 console.log(JSON.stringify({typecheck:t.status}));if(t.status!==0)process.exit(t.status??1);
}
const r=spawnSync(process.execPath,[join(nm,'vitest/vitest.mjs'),'run','--config','review-vitest.config.mjs',...filters],{cwd:stage,env,stdio:'inherit'});
console.log(JSON.stringify({stage,candidateFiles:files.length,supplemental:supplemental.length,baseline,exit:r.status}));
process.exit(r.status??1);
