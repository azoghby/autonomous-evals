import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageCore } from '../controlled-remediation-targets/stage-core.mjs';
import { applyRemediation, stageRemediation } from '../../../docs/controlled-remediation-targets/stage.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'docs/controlled-remediation-targets');
const source = join(dir, 'files/apps/web/src/app/api/internal/track-b-remediation');
const manifest = JSON.parse(await readFile(join(dir, 'PATCH.json')));
const artifact = JSON.parse(await readFile(join(root, manifest.artifact)));
const suite = artifact.outcome.suite;
const token = 'synthetic-offline-fixture-token-never-a-credential';
// Only test authority. This is NOT an approved Naive engineer proposal or a live candidate.
const replacement = suite.systemPrompt + '\nUse the literal reference answers and preserve every constraint.';
const sha = b => createHash('sha256').update(b).digest('hex');
const model = 'track-b-lumen-remediation-v1';
const url = 'https://fixture.invalid/api/internal/track-b-remediation/chat/completions';
const saved = { token: process.env.TRACK_B_ACCEPTANCE_TOKEN, digest: process.env.TRACK_B_REMEDIATION_PATCH_SHA256 };
let temp, core, route, objective, executeSuite, createRemediationTarget, remediationDigest;
function payload(system = replacement, scenario = suite.scenarios[0]) {
  return { model, messages: [{ role: 'system', content: system }, { role: 'user', content: scenario.userMessage }], max_completion_tokens: 512, store: false };
}
function request(body = payload(), { method = 'POST', auth = `Bearer ${token}`, headers = {}, raw = false } = {}) {
  return new Request(url, { method, headers: { ...(auth === null ? {} : { authorization: auth }), 'content-type': 'application/json', ...headers }, ...(['GET','HEAD'].includes(method) ? {} : { body: raw ? body : JSON.stringify(body) }) });
}
async function denied(body, status = 400, opts = {}) {
  const response = await route.POST(request(body, opts));
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const text = await response.text();
  assert.equal(text, JSON.stringify({ error: { type: 'controlled_fixture_error', message: 'Controlled fixture request rejected.' }, controlled_fixture: {origin:'internal_fixture',status:'deterministic_canned',global_correctness:false,remote_llm:false,live_llm:false,remote_prompt_patch_attestation:false} }));
  return text;
}
before(async () => {
  process.env.TRACK_B_ACCEPTANCE_TOKEN = token;
  process.env.TRACK_B_REMEDIATION_PATCH_SHA256 = sha(replacement);
  temp = await mkdtemp(join(tmpdir(), 'controlled-remediation-'));
  await writeFile(join(temp, 'package.json'), '{"type":"module"}');
  const deps = process.env.ACCEPTANCE_DEPENDENCIES ?? '/tmp/track-b-harness/node_modules';
  await symlink(deps, join(temp, 'node_modules'));
  const ts = createRequire(import.meta.url)(resolve(deps, 'typescript'));
  async function compile(from, to) {
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isDirectory()) await compile(join(from, item.name), join(to, item.name));
      else {
        const text = await readFile(join(from,item.name),'utf8');
        await writeFile(join(to,item.name), text);
        let js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        js = js.replace(/(from\s*)(['"])(\.[^'"]+)\2/g, '$1$2$3.js$2');
        await writeFile(join(to,item.name.replace(/\.ts$/,'.js')),js);
      }
    }
  }
  await compile(source, join(temp,'route'));
  await writeFile(join(temp,'tsconfig.json'),JSON.stringify({ compilerOptions: { target:'ES2022', module:'ESNext', moduleResolution:'Bundler', strict:true, noEmit:true, skipLibCheck:true, types:['node'] },include:['route/**/*.ts'] }));
  const check = spawnSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p',join(temp,'tsconfig.json')],{encoding:'utf8'});
  assert.equal(check.status,0,check.stdout+check.stderr);
  route = await import(pathToFileURL(join(temp,'route/chat/completions/route.js')));
  core = await stageCore(deps);
  const load = p => import(pathToFileURL(join(core.root,'src',p)));
  objective = (await load('evals/text/objective.js')).evaluateObjectiveCheck;
  executeSuite = (await load('evals/text/execute.js')).executeSuite;
  createRemediationTarget = (await load('targets/remediation.js')).createRemediationTarget;
  remediationDigest = (await load('evals/remediation/index.js')).remediationDigest;
  assert.equal((await load('evals/text/freeze.js')).verifyAdmittedFrozenSuite(suite).digest, manifest.suiteDigest);
});
after(async () => {
  for (const [key,value] of [['TRACK_B_ACCEPTANCE_TOKEN',saved.token],['TRACK_B_REMEDIATION_PATCH_SHA256',saved.digest]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await core?.cleanup(); if(temp) await rm(temp,{recursive:true,force:true});
});

import { createReceiptBridge, assertPromptApplication } from '../../../docs/acceptance-protocol-closure/identity/protocol.mjs';
async function fixture() {
  const binding = {targetId:'canonical-lumen',targetVersion:'pinned-lumen-remediation-v1',environment:'test'};
  const originalRun = await executeSuite(suite,'fixture-baseline',{target:{send:async r=>{
    const b = await (await route.POST(request(payload(suite.systemPrompt,suite.scenarios.find(s=>s.id===r.scenarioId))))).json();
    return {ok:true,text:b.choices[0].message.content,latencyMs:0};
  }},judge:null,evaluateObjective:objective});
  const finding = {id:'S01-marker',source:'text_eval',category:'instruction_violation',title:'Forbidden marker',label:'confirmed',severity:'medium',basis:'objective',summary:'S01 marker',evidence:[{kind:'check',checkId:'S01.o2',detail:'Forbidden marker'}],investigatorNote:null,reproduction:null};
  const scope = {job:artifact.input.job,finding,binding,original:{suite,run:originalRun,binding,failingCheckIds:['S01.o2']},trialId:'fixture-trial',endpoint:{kind:'stateless_chat_completions',isolation:'request_messages_only',url,model,apiKey:token}};
  const patch = {kind:'prompt_patch',summary:'Fixture replacement',patch:replacement,rationale:'Fixture transport contract only'};
  const rootDigest = remediationDigest({finding,binding,original:scope.original,trialId:scope.trialId});
  const inputs = suite.scenarios.map(s=>({request:{runId:`rem-${rootDigest.slice(0,48)}`,scenarioId:s.id,systemPrompt:replacement,userMessage:s.userMessage},patch,patchDigest:remediationDigest(patch),baselineRunId:originalRun.runId,suiteDigest:suite.digest}));
  const posts=[],before=[],observed=[],ambiguous=[];
  const deps = {scope,currentSecrets:async()=>[],limits:{timeoutMs:1000,maxCompletionTokens:512,maxRequestBytes:16384,maxResponseBytes:10000},accounting:{beforeDispatch:async e=>{before.push(e);},observed:async(e,u)=>{observed.push([e,u]);},ambiguous:async e=>{ambiguous.push(e);}},transport:{post:async(u,b,bearer)=>{
    // Explicit internal fixture-only injection, never a network-capable transport.
    assert.equal(u,url); assert.equal(bearer,token); assert.equal(b.model,model); assert.ok(Object.isFrozen(b));
    posts.push(b); const res=await route.POST(request(b)); if(!res.ok)throw Error('fixture rejected'); return res.json();
  }}};
  return {deps,inputs,posts,before,observed,ambiguous};
}
function attachBridge(f,reservations) {
 const bridge=createReceiptBridge({binding:f.deps.scope.binding,jobId:f.deps.scope.job.jobId,endpoint:{url,model},baselineSystemPrompt:suite.systemPrompt,approval:{approvalId:'synthetic-offline-review',approvedBy:'fixture-only',proposalTaskId:'synthetic-task',proposalSessionId:'synthetic-session',approvedPromptSha256:sha(replacement)},reserve:async(id,digest)=>{assert(!reservations.has(id),'durable replay denied');reservations.set(id,digest);}});
 const post=f.deps.transport.post;
 f.deps.transport.post=async(u,b,bearer)=>{const e=f.before.find(e=>e.scenarioId===suite.scenarios.find(s=>s.userMessage===b.messages[1].content).id);assert.equal(u,url);await bridge.beforeDispatch(e,b);return post(u,b,bearer);};
 const observed=f.deps.accounting.observed;
 f.deps.accounting.observed=async(e,u)=>{bridge.observed(e,u);await observed(e,u);};
 return bridge;
}
test('actual core all12 applied receipts bridge unchanged real version, reject forgery and cross-instance replay',async()=>{
 const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden');};
 try {
 const reservations=new Map(),f=await fixture(),bridge=attachBridge(f,reservations),trial=createRemediationTarget(f.deps);
 const receipts=[];
 for(const input of f.inputs){const result=await trial.send(input),e=f.before.find(e=>e.scenarioId===input.request.scenarioId);receipts.push(bridge.accept(result.value.receipt,e.operationId));assert.equal(f.observed.find(([o])=>o.operationId===e.operationId)[1],null);assert.throws(()=>bridge.accept({...result.value.receipt,targetVersion:'fabricated-new-version'},e.operationId));assert.throws(()=>bridge.accept({...result.value.receipt,actualSystemPrompt:'forged'},e.operationId));}
 assert.equal(f.posts.length,12);assert.equal(reservations.size,12);
 assert.deepEqual(receipts.map(r=>r.scenarioId),suite.scenarios.map(s=>s.id));
 assert.equal(assertPromptApplication({targetVersionBefore:f.deps.scope.binding.targetVersion,targetVersionAfter:f.deps.scope.binding.targetVersion,promptApplication:bridge.promptApplication(),appliedReceipts:receipts}),true);
 attachBridge(f,reservations);await assert.rejects(createRemediationTarget(f.deps).send(f.inputs[0]));assert.equal(f.posts.length,12);assert.equal(reservations.size,12);
 } finally{globalThis.fetch=savedFetch;}
});
test('applied-source v2 validator preserves old checks and accepts honest same-version prompt application',async()=>{
 const { CALENDAR_IDS, CALENDAR_CANONICAL_DIGEST }=await import('../../../docs/acceptance-protocol-closure/identity/protocol.mjs');
 const identityManifest=JSON.parse(await readFile(join(root,'docs/acceptance-protocol-closure/identity/PATCH.json')));
 const path='tests/track-b/live-acceptance/provider/app-run.mjs';
 assert.equal(sha(await readFile(join(root,path))),identityManifest.baseFileSha256);
 assert.equal(sha(await readFile(join(root,'docs/acceptance-protocol-closure/identity/protocol.mjs'))),identityManifest.adapterSha256);
 const stage=join(temp,'v2'),target=join(stage,path);await mkdir(join(stage,'tests/track-b/live-acceptance/provider'),{recursive:true});await writeFile(target,await readFile(join(root,path)));
 const moduleDir=join(stage,'docs/acceptance-protocol-closure/identity');await mkdir(moduleDir,{recursive:true});await writeFile(join(moduleDir,'protocol.mjs'),await readFile(join(root,'docs/acceptance-protocol-closure/identity/protocol.mjs')));
 const patch=spawnSync('git',['apply',join(root,'docs/acceptance-protocol-closure/identity/0001-v2-identity-compatibility.patch')],{cwd:stage,encoding:'utf8'});assert.equal(patch.status,0,patch.stderr);assert.equal(sha(await readFile(target)),identityManifest.resultSha256);
 const {validateEvidence}=await import(pathToFileURL(target));
 // Reuse only the explicit synthetic schema fixture declaration; do not import/run historical tests.
 const originalTests=await readFile(join(root,'tests/track-b/live-acceptance/provider/app-run.test.mjs'),'utf8');
 const declaration=originalTests.slice(originalTests.indexOf('const fixture = () => {'),originalTests.indexOf("test('offline synthetic"));
 const schemaFixture=Function('TEXT_DIGEST','EVIDENCE_SCHEMA',declaration+';return fixture;')(suite.digest,'app_acceptance/v2');
 const e=schemaFixture();assert.equal(validateEvidence(e),true);
 const f=await fixture(),bridge=attachBridge(f,new Map()),trial=createRemediationTarget(f.deps),receipts=[];
 for(const input of f.inputs){const r=await trial.send(input),d=f.before.find(d=>d.scenarioId===input.request.scenarioId);receipts.push(bridge.accept(r.value.receipt,d.operationId));}
 e.remediation={...e.remediation,targetId:f.deps.scope.binding.targetId,targetVersionBefore:f.deps.scope.binding.targetVersion,targetVersionAfter:f.deps.scope.binding.targetVersion,suiteDigest:suite.digest,baselineRunId:receipts[0].baselineRunId,trialRunId:receipts[0].trialRunId,patchDigest:receipts[0].patchDigest,appliedReceipts:receipts,promptApplication:bridge.promptApplication()};
 e.text.baseline.runId=e.remediation.baselineRunId;e.text.trial.runId=e.remediation.trialRunId;
 Object.assign(e.reports.text,{baselineRunId:e.remediation.baselineRunId,trialRunId:e.remediation.trialRunId});
 const ids=[e.remediation.operationId,...receipts.map(r=>r.operationId)];e.accounting.operationIds=ids;e.accounting.costRows=ids.map(operationId=>({operationId,costMicroUsd:null,measured:false}));
 const c=e.calendar;c.reviewedScenarioIds=[...CALENDAR_IDS];c.versionBinding={kind:'independent_job_suites',canonicalScenarioDigest:CALENDAR_CANONICAL_DIGEST,baseline:{jobId:'before-job',suiteDigest:c.suiteDigest},trial:{jobId:'after-job',suiteDigest:'e'.repeat(64)}};
 for(const [phase,b] of [['buggy',c.versionBinding.baseline],['fixed',c.versionBinding.trial]]){Object.assign(c[phase],b,{scenarioIds:[...CALENDAR_IDS],passed:phase==='buggy'?10:12,productFailures:phase==='buggy'?2:0});c[phase].sqlEvidence=CALENDAR_IDS.map((scenarioId,i)=>({...b,scenarioId,runId:c[phase].runId,branchId:`branch-${phase}`,beforeStateDigest:'b'.repeat(64),afterStateDigest:'c'.repeat(64),assertions:[{checkId:scenarioId+'.state',status:phase==='buggy'&&i<2?'fail':'pass'}]}));}
 Object.assign(e.reports.calendar,{trialSuiteDigest:c.fixed.suiteDigest,baselineJobId:c.buggy.jobId,trialJobId:c.fixed.jobId});
 assert.equal(validateEvidence(e),true);
 for(const mutate of [x=>delete x.remediation.promptApplication,x=>x.remediation.appliedReceipts[0].targetVersion='fake',x=>x.remediation.appliedReceipts[0].appliedPromptSha256='f'.repeat(64),x=>x.calendar.fixed.sqlEvidence[0].jobId='wrong',x=>x.calendar.fixed.sqlEvidence[0].assertions[0].status='fail',x=>x.accounting.costRows[0].measured=true,x=>x.privateChat.anonymousStatus=200,x=>x.restart.processAfter=x.restart.processBefore]){const bad=structuredClone(e);mutate(bad);assert.throws(()=>validateEvidence(bad));}
});
