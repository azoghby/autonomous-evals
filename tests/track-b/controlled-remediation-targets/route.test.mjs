import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageCore } from './stage-core.mjs';
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
test('exact artifact, all12 scenarios and criteria retained; additive patch applies to pinned latest A', async () => {
  assert.equal(sha(await readFile(join(root,manifest.artifact))),manifest.artifactSha256);
  assert.equal(suite.systemPrompt,manifest.baselineSystem);
  assert.equal(sha(suite.systemPrompt),manifest.baselineSystemSha256);
  assert.equal(suite.scenarios.length,12);
  const destination = join(temp,'application');
  const staged = stageRemediation(destination);
  assert.equal(staged.trackA,'530af32067279497161c22ab00006247851d9200');
  assert.throws(()=>applyRemediation(destination),/overwrite/);
});
test('SAME endpoint/model: exactly one baseline objective failure, replacement passes every objective; literal reference answers', async () => {
  let failures = [];
  const expected = [/3 projects/,/12 projects/,/Monday through Friday/,/fictional service/,/3 projects/,/12 projects/,/3 projects/,/Monday through Friday/];
  for(const [i,s] of suite.scenarios.entries()) {
    for(const system of [suite.systemPrompt,replacement]) {
      const response = await route.POST(request(payload(system,s)));
      assert.equal(response.status,200);
      const b = await response.json(), text = b.choices[0].message.content;
      assert.equal(b.model,model); assert.equal(b.usage,undefined);
      assert.deepEqual(b.controlled_fixture,{origin:'internal_fixture',status:'deterministic_canned',global_correctness:false,remote_llm:false,suite_digest:suite.digest,scenario_id:s.id,live_llm:false,remote_prompt_patch_attestation:false});
      for(const c of s.objectiveChecks) {
        const status = objective(c,text).status;
        if(system === replacement) assert.equal(status,'pass',c.id);
        else if(status !== 'pass') { assert.equal(status,'fail'); failures.push(c.id); }
      }
      if(i<8) assert.match(text,expected[i]); else assert.equal(text,'Not specified in the reference.');
    }
  }
  assert.deepEqual(failures,['S01.o2']);
});
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
test('actual core trial all12 concurrent receipts derive from posted system, not host echoes; usage unknown',async()=>{
  const f=await fixture(), trial=createRemediationTarget(f.deps);
  const results=await Promise.all(f.inputs.map(i=>trial.send(i)));
  assert.equal(f.posts.length,12); assert.equal(f.before.length,12); assert.equal(f.observed.length,12); assert.equal(f.ambiguous.length,0);
  for(const [i,result] of results.entries()) {
    const input=f.inputs[i], b=f.posts.find(b=>b.messages[1].content===input.request.userMessage);
    assert.deepEqual(b,payload(replacement,suite.scenarios[i]));
    assert.equal(result.value.receipt.actualSystemPrompt,b.messages[0].content);
    assert.equal(result.value.receipt.patchDigest,remediationDigest({...input.patch,patch:b.messages[0].content}));
    assert.equal(result.value.receipt.scenarioId,suite.scenarios[i].id);
    assert.equal(result.value.receipt.suiteDigest,suite.digest);
    const evidence=f.before.find(e=>e.scenarioId===suite.scenarios[i].id);
    assert.equal(evidence.payloadDigest,remediationDigest(b));
    assert.equal(f.observed.find(([e])=>e.scenarioId===suite.scenarios[i].id)[1],null);
    for(const c of suite.scenarios[i].objectiveChecks)assert.equal(objective(c,result.value.response.text).status,'pass');
    assert.deepEqual(result.costs,[]);
  }
  await assert.rejects(trial.send(f.inputs[0])); assert.equal(f.posts.length,12);
});
test('current secrets refreshed immediately before dispatch; refused runs have no outbound',async()=>{
  for(const mode of ['current','rotated','credential','unknown-patch','branch','user','extra-cap']) {
    const f=await fixture(); const input=structuredClone(f.inputs[0]); let calls=0;
    if(mode==='current')f.deps.currentSecrets=async()=>['literal reference'];
    if(mode==='rotated')f.deps.currentSecrets=async()=>++calls===1?[]:['literal reference'];
    if(mode==='credential'){input.patch.patch=token;input.request.systemPrompt=token;input.patchDigest=remediationDigest(input.patch);}
    if(mode==='unknown-patch'){input.patch.patch+=' unreviewed';input.request.systemPrompt=input.patch.patch;input.patchDigest=remediationDigest(input.patch);}
    if(mode==='branch'){f.deps.scope.binding.targetVersion='other-branch';f.deps.scope.original.binding={...f.deps.scope.binding};}
    if(mode==='user') input.request.userMessage+=' ';
    if(mode==='extra-cap')f.deps.limits.maxRequestBytes=1;
    const trial=createRemediationTarget(f.deps);
    await assert.rejects(trial.send(input));
    assert.equal(f.posts.length,mode==='unknown-patch'?1:0,mode);
  }
});
test('server-only authority: missing/invalid/equal baseline digest disabled, owner digest rotation changes byte admission',async()=>{
  try {
    for(const digest of [undefined,'','0','A'.repeat(64),sha(suite.systemPrompt)]) {
      if(digest===undefined)delete process.env.TRACK_B_REMEDIATION_PATCH_SHA256;else process.env.TRACK_B_REMEDIATION_PATCH_SHA256=digest;
      await denied(payload(),503); await denied(payload(suite.systemPrompt),503);
    }
    process.env.TRACK_B_REMEDIATION_PATCH_SHA256=sha(replacement+' reviewed separately');
    await denied(payload());
    assert.equal((await route.POST(request(payload(replacement+' reviewed separately')))).status,200);
  } finally {process.env.TRACK_B_REMEDIATION_PATCH_SHA256=sha(replacement);}
});
test('private bounds, auth before body, no arbitrary tools/messages/claims/tenant/branch mutation authority',async()=>{
  for(const body of [null,{},[],{...payload(),model:'fixed'},{...payload(),tools:[]},{...payload(),stream:true},{...payload(),store:true},...['tenantId','customerId','targetVersion','branchId','approvedPatchDigest','receipt','environment'].map(k=>({...payload(),[k]:sha('unapproved')}))]) await denied(body);
  for(const system of [replacement+' ',suite.systemPrompt+' ', 'unapproved', '\ud800'])await denied(payload(system));
  for(const messages of [[],payload().messages.toReversed(),[...payload().messages,{role:'user',content:'extra'}],[payload().messages[0],{...payload().messages[1],tool_calls:[]}]])await denied({...payload(),messages});
  for(const cap of [0,15,513,16.5,'512',null])await denied({...payload(),max_completion_tokens:cap});
  for(const auth of [null,'Bearer bad',`Bearer ${token}extra`,`bearer ${token}`])await denied('sensitive-canary',401,{auth,raw:true});
  const req=request();req.headers.delete('authorization');Object.defineProperty(req,'body',{get(){throw Error('body read before auth');}});assert.equal((await route.POST(req)).status,401);
  for(const value of [undefined,'','bad','x'.repeat(257)]) {
    try {if(value===undefined)delete process.env.TRACK_B_ACCEPTANCE_TOKEN;else process.env.TRACK_B_ACCEPTANCE_TOKEN=value;await denied(payload(),503);}
    finally {process.env.TRACK_B_ACCEPTANCE_TOKEN=token;}
  }
  await denied('x'.repeat(16385),413,{raw:true});
  await denied('🧪'.repeat(4097),413,{raw:true,headers:{'content-length':'1'}});
  await denied(payload(),413,{headers:{'content-length':'16385'}});
  await denied(payload(),415,{headers:{'content-encoding':'gzip'}});
  await denied(payload(),415,{headers:{'content-type':'text/plain'}});
  await denied(new Uint8Array([255]),400,{raw:true});
  await denied('{',400,{raw:true});
  for(const method of ['GET','HEAD','PUT','PATCH','DELETE','OPTIONS'])assert.equal((await route[method](request(payload(),{method}))).status,405);
});
test('concurrent baseline/replacement requests remain isolated and route makes no outbound calls',async()=>{
  const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('outbound forbidden');};
  try {
    const jobs=Array.from({length:48},(_,i)=>({system:i%2?replacement:suite.systemPrompt,s:suite.scenarios[Math.floor(i/2)%12]}));
    const results=await Promise.all(jobs.map(async j=>(await(await route.POST(request(payload(j.system,j.s)))).json()).choices[0].message.content));
    for(const [i,j] of jobs.entries())assert.equal(results[i].includes('INTERNAL_ONLY'),j.system===suite.systemPrompt&&j.s.id==='S01');
  } finally {globalThis.fetch=old;}
});
test('response secret filtering and concurrent duplicate fence never manufacture a second receipt',async()=>{
  const f=await fixture();
  f.deps.currentSecrets=async()=>['Monday through Friday'];
  await assert.rejects(createRemediationTarget(f.deps).send(f.inputs[2]));
  assert.equal(f.posts.length,1);assert.equal(f.ambiguous.length,1);
  const g=await fixture(),trial=createRemediationTarget(g.deps);
  const results=await Promise.allSettled([trial.send(g.inputs[0]),trial.send(g.inputs[0])]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(g.posts.length,1);assert.equal(g.before.length,1);
});
test('streamed byte cap cancels input and server bearer rotation revokes old token',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}});
  const req=new Request(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:stream,duplex:'half'});
  assert.equal((await route.POST(req)).status,413);assert.equal(cancelled,true);
  try {process.env.TRACK_B_ACCEPTANCE_TOKEN=token+'-rotated';await denied(payload(),401);}
  finally {process.env.TRACK_B_ACCEPTANCE_TOKEN=token;}
  assert.equal((await route.POST(request())).status,200);
});
