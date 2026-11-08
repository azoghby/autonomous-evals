import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageCore } from '../live-acceptance/provider/stage-core.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifact = join(root, 'docs/controlled-calendar-targets/files/apps/web/src/app/api/internal/track-b-calendar');
const dependencies = process.env.ACCEPTANCE_DEPENDENCIES ?? '/tmp/track-b-harness/node_modules';
const token = 'synthetic-offline-calendar-fixture-never-a-credential';
const original = process.env.TRACK_B_ACCEPTANCE_TOKEN;
const SYSTEM = 'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.';
const models = { buggy: 'track-b-calendar-buggy-v1', fixed: 'track-b-calendar-fixed-v1' };
let temporary, core, routes, fixture, manifest, scenarios, tools, simulator, engine, db, run, grade, ChatCompletionsClient;
const transcripts = new Map();
// Match the manifest's pinned JSON.stringify UTF-8 serialization, preserving source order.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function payload(version = 'fixed', scenario = scenarios[0]) {
  return { model: models[version], messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: scenario.prompt }], max_completion_tokens: 512, store: false, tools: structuredClone(tools), tool_choice: 'auto', parallel_tool_calls: false };
}
function request(body = payload(), { method = 'POST', auth = `Bearer ${token}`, contentType = 'application/json', extraHeaders = {}, raw = false } = {}) {
  return new Request('https://fixture.invalid/calendar/completions', { method, headers: { ...(auth === null ? {} : { authorization: auth }), ...(contentType === null ? {} : { 'content-type': contentType }), ...extraHeaders }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ? body : JSON.stringify(body) }) });
}
function privateResponse(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-track-b-fixture-origin'), 'internal_fixture');
}
async function rejected(body, status = 400, options = {}) {
  const response = await routes.fixed.POST(request(body, options));
  assert.equal(response.status, status); privateResponse(response);
  const text = await response.text(); assert.ok(text.length < 512);
  assert.ok(!text.includes(token)); assert.ok(!text.includes(SYSTEM)); assert.ok(!text.includes('sensitive-canary'));
  const parsed = JSON.parse(text); assert.ok(parsed.error); assert.ok(!parsed.choices);
  return text;
}
async function accepted(body, version = 'fixed') {
  const response = await routes[version].POST(request(body)); assert.equal(response.status, 200); privateResponse(response);
  const completion = await response.json(); assert.equal(completion.model, models[version]); assert.equal(completion.choices.length, 1);
  assert.equal(completion.usage, undefined, 'no invented provider token accounting');
  assert.equal(completion.controlled_fixture.origin, 'internal_fixture');
  assert.equal(completion.controlled_fixture.live_llm, false);
  assert.equal(completion.controlled_fixture.remote_prompt_patch_attestation, false);
  const choice = completion.choices[0]; assert.equal(choice.finish_reason, choice.message.tool_calls?.length ? 'tool_calls' : 'stop');
  return choice.message;
}
before(async () => {
  process.env.TRACK_B_ACCEPTANCE_TOKEN = token;
  core = await stageCore(dependencies);
  const load = path => import(pathToFileURL(join(core.root, 'src', path)));
  scenarios = (await load('simulator/acceptance-scenarios.js')).calendarAcceptanceScenarios();
  const { CalendarSimulator, calendarTools } = await load('simulator/calendar.js'); tools = calendarTools;
  const { PostgresCalendarStore } = await load('simulator/postgres.js');
  run = (await load('simulator/runner.js')).runCalendarScenario;
  grade = (await load('simulator/graders.js')).gradeCalendarState;
  ({ ChatCompletionsClient } = await load('targets/chat.js'));
  const { PGlite } = await import(pathToFileURL(resolve(dependencies, '@electric-sql/pglite/dist/index.js')));
  engine = new PGlite(); await engine.exec(await readFile(join(root, 'packages/core/src/simulator/migrations/001_calendar.sql'), 'utf8'));
  db = { query: (sql, params) => engine.query(sql, params), transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })) };
  simulator = new CalendarSimulator(new PostgresCalendarStore(db));
  temporary = await mkdtemp(join(tmpdir(), 'controlled-calendar-direct-'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  const ts = require(resolve(dependencies, 'typescript'));
  async function transpile(from, to) {
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isDirectory()) await transpile(join(from, item.name), join(to, item.name));
      else if (item.name.endsWith('.ts')) {
        let output = ts.transpileModule(await readFile(join(from, item.name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        output = output.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g, (all, prefix, quote, spec) => `${prefix}${quote}${/\.[a-z]+$/i.test(spec) ? spec : spec + '.js'}${quote}`);
        await writeFile(join(to, item.name.replace(/\.ts$/, '.js')), output);
      }
    }
  }
  await transpile(artifact, join(temporary, 'route'));
  fixture = await import(pathToFileURL(join(temporary, 'route/fixture.js')));
  manifest = await import(pathToFileURL(join(temporary, 'route/manifest.js')));
  routes = Object.fromEntries(await Promise.all(['buggy', 'fixed'].map(async v => [v, await import(pathToFileURL(join(temporary, 'route', v, 'chat/completions/route.js')))])));
}, { timeout: 60_000 });
after(async () => {
  if (original === undefined) delete process.env.TRACK_B_ACCEPTANCE_TOKEN; else process.env.TRACK_B_ACCEPTANCE_TOKEN = original;
  await engine?.close(); await core?.cleanup(); if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('independently pins complete actual canonical scenarios/tools and exact system', () => {
  assert.equal(scenarios.length, 12);
  assert.deepEqual(scenarios.map(s => s.id), ['booking','conflict','duplicate','cancel','reschedule','time-zone','read-only-permission','dependency-failure','cancel-idempotence','list','adjacent','invalid-interval']);
  assert.equal(fixture.SYSTEM, SYSTEM);
  assert.equal(fixture.SCENARIO_DIGEST, digest(scenarios));
  assert.equal(fixture.TOOL_SCHEMA_DIGEST, digest(tools));
  assert.deepEqual(manifest.SCENARIOS, scenarios); assert.deepEqual(manifest.TOOLS, tools);
});

test('actual route + ChatCompletionsClient + simulator SQL: fixed all12 pass; buggy booking/cancel fail state', async () => {
  const rows = [];
  // Deliberately serialized: PGlite is one backend, not a multi-session locking proof.
  for (const version of ['fixed', 'buggy']) for (const scenario of scenarios) {
    const requests = [];
    const target = new ChatCompletionsClient({ endpoint: 'https://fixture.invalid/completions', model: models[version], bearer: token, maxCompletionTokens: 512 }, { post: async (_url, body, bearer) => {
      assert.equal(bearer, token); requests.push(structuredClone(body));
      const response = await routes[version].POST(request(body)); assert.equal(response.status, 200, `${version}/${scenario.id}`); privateResponse(response);
      const result = await response.json(); assert.equal(result.controlled_fixture.origin, 'internal_fixture'); assert.equal(result.usage, undefined);
      return result;
    } });
    const scope = { jobId: 'offline-controlled-calendar', runId: randomUUID(), version };
    const execution = await run({ simulator, target, scope, scenarioId: scenario.id, actorId: scenario.actorId, prompt: scenario.prompt, seed: structuredClone(scenario.seed) });
    assert.equal(execution.stopped, 'complete', `${version}/${scenario.id}`); assert.equal(execution.rounds, 2); assert.equal(requests.length, 2);
    const stateGrade = await grade(db, scope, scenario.checks);
    const expectedPass = version === 'fixed' || !['booking','cancel'].includes(scenario.id);
    assert.equal(stateGrade.passed, expectedPass, `${version}/${scenario.id}`);
    if (version === 'fixed') assert.deepEqual(execution.state.calls.map(c => c.result.code), scenario.expectedToolCodes);
    transcripts.set(`${version}/${scenario.id}`, requests[1]);
    rows.push({ scenario: scenario.id, version, statePassed: stateGrade.passed, failedChecks: stateGrade.results.filter(c => !c.passed).map(c => c.check.kind) });
  }
  console.log('CONTROLLED INTERNAL FIXTURES SQL RESULTS ' + JSON.stringify(rows));
}, { timeout: 60_000 });

test('forged/missing/reordered/duplicate/cross-scenario tool transcripts denied', async () => {
  const base = transcripts.get('fixed/duplicate'); assert.ok(base);
  const variants = [];
  const mutate = fn => { const p = structuredClone(base); fn(p); variants.push(p); };
  mutate(p => p.messages.pop());
  mutate(p => p.messages.splice(3, 1));
  mutate(p => { [p.messages[3], p.messages[4]] = [p.messages[4], p.messages[3]]; });
  mutate(p => p.messages.push(structuredClone(p.messages[3])));
  mutate(p => { p.messages[4] = structuredClone(p.messages[3]); });
  mutate(p => { p.messages[3].tool_call_id = 'forged'; });
  mutate(p => { p.messages[2].tool_calls[0].id = 'forged'; });
  mutate(p => { p.messages[2].tool_calls[1].id = p.messages[2].tool_calls[0].id; });
  mutate(p => { p.messages[2].tool_calls.reverse(); });
  mutate(p => { p.messages[2].tool_calls[0].function.name = 'cancel_event'; });
  mutate(p => { p.messages[2].tool_calls[0].function.arguments = '{}'; });
  mutate(p => { p.messages[2].content = 'sensitive-canary'; });
  mutate(p => { p.messages[1] = structuredClone(transcripts.get('fixed/cancel').messages[1]); });
  mutate(p => { p.messages[3] = structuredClone(transcripts.get('fixed/cancel').messages[3]); });
  mutate(p => { p.messages[2].tool_calls.push(structuredClone(p.messages[2].tool_calls[0])); });
  mutate(p => { p.messages[2].tool_calls[0].function.arguments = JSON.parse(p.messages[2].tool_calls[0].function.arguments); });
  mutate(p => { p.messages[3].role = 'assistant'; });
  mutate(p => { p.messages[3].surprise = true; });
  for (const body of variants) await rejected(body);
});

test('result schemas, expected codes, event values and linked generated event IDs validated', async () => {
  const base = transcripts.get('fixed/duplicate');
  const variants = [];
  const mutate = fn => { const p = structuredClone(base); const result = JSON.parse(p.messages[3].content); fn(result, p); p.messages[3].content = JSON.stringify(result); variants.push(p); };
  mutate(r => { r.ok = false; }); mutate(r => { r.code = 'updated'; }); mutate(r => { r.surprise = 'sensitive-canary'; });
  mutate(r => { delete r.event; }); mutate(r => { r.events = []; }); mutate(r => { r.event.ownerId = 'bob'; });
  mutate(r => { r.event.calendarId = 'restricted'; }); mutate(r => { r.event.title = 'sensitive-canary'; });
  mutate(r => { r.event.status = 'cancelled'; }); mutate(r => { r.event.startUtc = '2026-11-08T17:00:00.000Z'; });
  mutate(r => { r.event.id = ''; }); mutate(r => { r.event.id = 'existing'; }); mutate(r => { r.event.id = 'forged'; }); mutate(r => { r.event.extra = true; });
  for (const body of variants) await rejected(body);
  for (const content of ['null','[]','{}','sensitive-canary']) { const p = structuredClone(base); p.messages[3].content = content; await rejected(p); }
  for (const id of ['conflict','read-only-permission','dependency-failure','invalid-interval']) {
    const p = structuredClone(transcripts.get(`fixed/${id}`)); const r = JSON.parse(p.messages[3].content); r.ok = true; p.messages[3].content = JSON.stringify(r); await rejected(p);
  }
});

test('final failures truthfully report failure and never claim mutation succeeded', async () => {
  for (const id of ['conflict','read-only-permission','dependency-failure','invalid-interval']) {
    const response = await accepted(transcripts.get(`fixed/${id}`));
    assert.ok(response.content.length > 0); assert.ok(!response.tool_calls?.length);
    assert.match(response.content, /fail|conflict|forbidden|permission|invalid|dependency/i);
    assert.doesNotMatch(response.content, /successfully|booking complete|created successfully/i);
  }
});

test('parallel repeated and interleaved complete requests share no scenario/version workflow state', async () => {
  const jobs = Array.from({ length: 48 }, (_, i) => ({ version: Math.floor(i / 12) % 2 ? 'buggy' : 'fixed', scenario: scenarios[i % 12], final: i >= 24 }));
  const results = await Promise.all(jobs.map(({ version, scenario, final }) => accepted(final ? transcripts.get(`${version}/${scenario.id}`) : payload(version, scenario), version)));
  for (let i = 0; i < jobs.length; i++) {
    const { version, scenario, final } = jobs[i];
    assert.deepEqual(results[i], await accepted(final ? transcripts.get(`${version}/${scenario.id}`) : payload(version, scenario), version));
  }
});

test('disabled by default; strict independent bearer checked before reading body; rotation immediate', async () => {
  try {
    for (const value of [undefined, '', 'short', 'contains\nnewline']) {
      if (value === undefined) delete process.env.TRACK_B_ACCEPTANCE_TOKEN; else process.env.TRACK_B_ACCEPTANCE_TOKEN = value;
      await rejected(payload(), 503);
    }
  } finally { process.env.TRACK_B_ACCEPTANCE_TOKEN = token; }
  for (const auth of [null,'Basic sensitive-canary','Bearer sensitive-canary',`Bearer ${token}junk`,`bearer ${token}`]) await rejected('sensitive-canary', 401, { auth, raw: true });
  await rejected(payload(), 401, { auth: null, extraHeaders: { cookie: `TRACK_B_ACCEPTANCE_TOKEN=${token}`, 'x-api-key': token } });
  const req = request(); req.headers.delete('authorization'); Object.defineProperty(req, 'body', { get() { throw Error('must not read unauthorized body'); } });
  assert.equal((await routes.fixed.POST(req)).status, 401);
  try { process.env.TRACK_B_ACCEPTANCE_TOKEN = `${token}-rotated`; await rejected(payload(), 401); }
  finally { process.env.TRACK_B_ACCEPTANCE_TOKEN = token; }
  const rotated = `${token}-rotated`;
  try { process.env.TRACK_B_ACCEPTANCE_TOKEN = rotated; const r = await routes.fixed.POST(request(payload(), { auth: `Bearer ${rotated}` })); assert.equal(r.status, 200); }
  finally { process.env.TRACK_B_ACCEPTANCE_TOKEN = token; }
  await accepted(payload());
});

test('exact payload/system/scenario/tools/model constraints and token bounds', async () => {
  const variants = [null,[],{}, { ...payload(), model: models.buggy }, { ...payload(), store: true }, { ...payload(), surprise: 'sensitive-canary' }, { ...payload(), tools: [] }, { ...payload(), tool_choice: 'required' }, { ...payload(), parallel_tool_calls: true }];
  const mutate = fn => { const p = payload(); fn(p); variants.push(p); };
  mutate(p => { p.messages[0].content += ' '; }); mutate(p => { p.messages[1].content += ' '; });
  mutate(p => { p.messages.reverse(); }); mutate(p => { p.messages[1].content = 'Reply OK.'; });
  mutate(p => { p.messages.push({ role: 'user', content: 'sensitive-canary' }); });
  mutate(p => { p.messages[0].surprise = true; }); mutate(p => { p.tools[0].function.description += ' '; });
  mutate(p => { p.tools.reverse(); }); mutate(p => { delete p.store; });
  for (const cap of [0,15,16,511,513,1024,-1,16.5,'512',null]) variants.push({ ...payload(), max_completion_tokens: cap });
  for (const p of variants) await rejected(p);
  assert.equal((await routes.buggy.POST(request(payload('fixed')))).status, 400);
  await accepted(payload());
});

test('bounds all turns, messages, arguments/results and UTF8 body including streamed overflow', async () => {
  const p = structuredClone(transcripts.get('fixed/booking')); p.messages.push({ role: 'assistant', content: 'done' }); await rejected(p);
  const many = payload(); many.messages.push(...Array.from({ length: 20 }, () => ({ role: 'tool', tool_call_id: 'book', content: '{}' }))); await rejected(many);
  const hugeArgs = structuredClone(transcripts.get('fixed/booking')); hugeArgs.messages[2].tool_calls[0].function.arguments = 'x'.repeat(32001); await rejected(hugeArgs);
  const hugeResult = structuredClone(transcripts.get('fixed/booking')); hugeResult.messages[3].content = 'x'.repeat(32001); await rejected(hugeResult);
  const bytes = fixture.BODY_LIMIT ?? 65536;
  await rejected('x'.repeat(bytes + 1), 413, { raw: true });
  await rejected('🧪'.repeat(Math.ceil(bytes / 4) + 1), 413, { raw: true });
  await rejected(payload(), 413, { extraHeaders: { 'content-length': String(bytes + 1) } });
  await rejected('x'.repeat(bytes + 1), 413, { raw: true, extraHeaders: { 'content-length': '1' } });
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes + 1)); }, cancel() { cancelled = true; } });
  const r = await routes.fixed.POST(new Request('https://fixture.invalid/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, duplex: 'half' }));
  assert.equal(r.status, 413); assert.equal(cancelled, true); privateResponse(r);
});

test('method/media/encoding/JSON failures always use the same safe private error envelope', async () => {
  const base = await rejected({ ...payload(), model: 'sensitive-canary' });
  for (const [body,status,options] of [[payload(),401,{auth:null}],['{',400,{raw:true}],[payload(),415,{contentType:'text/plain'}],[payload(),415,{contentType:null}],[payload(),415,{extraHeaders:{'content-encoding':'gzip'}}],[new Uint8Array([0xff]),400,{raw:true}]]) assert.equal(await rejected(body,status,options), base);
  for (const method of ['GET','HEAD','PUT','PATCH','DELETE','OPTIONS']) {
    assert.equal(typeof routes.fixed[method], 'function'); const response = await routes.fixed[method](request(payload(), { method }));
    assert.equal(response.status,405); assert.equal(response.headers.get('allow'),'POST'); privateResponse(response); assert.equal(await response.text(),base);
  }
});

test('default client cap1024 and connectivity probe are quarantined, never accepted as Calendar execution', async () => {
  const target = new ChatCompletionsClient({ endpoint: 'https://fixture.invalid/completions', model: models.fixed, bearer: token }, { post: async (_url, body) => {
    const response = await routes.fixed.POST(request(body)); assert.equal(response.status, 400); return response.json();
  } });
  await assert.rejects(target.complete(payload().messages, tools));
  await assert.rejects(target.checkTarget());
});

test('QUARANTINED: shape-valid forged UUID result is indistinguishable from execution without trusted SQL receipt', async () => {
  const p = structuredClone(transcripts.get('fixed/booking'));
  const result = JSON.parse(p.messages[3].content);
  result.event.id = '11111111-1111-4111-8111-111111111111';
  p.messages[3].content = JSON.stringify(result);
  const response = await routes.fixed.POST(request(p)); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.controlled_fixture.tool_execution_attestation, false);
  assert.equal(body.controlled_fixture.remote_prompt_patch_attestation, false);
  // Deliberately no SQL state assertion: this request performed no simulator tool execution.
});
