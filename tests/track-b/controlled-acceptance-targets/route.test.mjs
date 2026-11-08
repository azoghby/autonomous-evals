import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageCore } from '../live-acceptance/provider/stage-core.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'docs/controlled-acceptance-targets/files/apps/web/src/app/api/internal/track-b-acceptance');
const artifact = JSON.parse(await readFile(join(root, 'packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json'), 'utf8'));
const suite = artifact.outcome.suite;
const digest = '0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9';
const token = 'synthetic-offline-fixture-token-never-a-credential';
const original = process.env.TRACK_B_ACCEPTANCE_TOKEN;
const models = { buggy: 'track-b-lumen-buggy-v1', fixed: 'track-b-lumen-fixed-v1' };
let temporary, core, routes, objective, createTextTarget;

// Independently canonicalize the admitted artifact; never import the route's lookup/oracle.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function payload(version = 'fixed', scenario = suite.scenarios[0]) {
  return { model: models[version], messages: [{ role: 'system', content: suite.systemPrompt }, { role: 'user', content: scenario.userMessage }], max_completion_tokens: 512, store: false };
}
function request(body = payload(), { method = 'POST', auth = `Bearer ${token}`, contentType = 'application/json', extraHeaders = {}, raw = false } = {}) {
  return new Request('https://fixture.invalid/api/internal/track-b-acceptance/fixed/chat/completions', { method, headers: { ...(auth === null ? {} : { authorization: auth }), ...(contentType === null ? {} : { 'content-type': contentType }), ...extraHeaders }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ? body : JSON.stringify(body) }) });
}
function privateResponse(response) {
  assert.match(response.headers.get('cache-control') ?? '', /private/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
}
async function rejected(body, status = 400, options = {}) {
  const response = await routes.fixed.POST(request(body, options));
  assert.equal(response.status, status); privateResponse(response);
  const text = await response.text();
  assert.ok(text.length < 512);
  assert.ok(!text.includes(token)); assert.ok(!text.includes(suite.systemPrompt));
  assert.ok(!text.includes('sensitive-canary'));
  const parsed = JSON.parse(text); assert.equal(typeof parsed.error, 'object');
  assert.ok(!parsed.choices);
  return text;
}

before(async () => {
  process.env.TRACK_B_ACCEPTANCE_TOKEN = token;
  temporary = await mkdtemp(join(tmpdir(), 'controlled-target-direct-'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  const dependencies = process.env.ACCEPTANCE_DEPENDENCIES ?? '/tmp/track-b-harness/node_modules';
  const ts = require(resolve(dependencies, 'typescript'));
  async function transpile(from, to) {
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isDirectory()) await transpile(join(from, item.name), join(to, item.name));
      else if (item.name.endsWith('.ts')) {
        let compiled = ts.transpileModule(await readFile(join(from, item.name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        compiled = compiled.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g, (all, prefix, quote, spec) => `${prefix}${quote}${/\.[a-z]+$/i.test(spec) ? spec : spec + '.js'}${quote}`);
        await writeFile(join(to, item.name.replace(/\.ts$/, '.js')), compiled);
      }
    }
  }
  await transpile(source, join(temporary, 'route'));
  routes = Object.fromEntries(await Promise.all(['buggy', 'fixed'].map(async version => [version, await import(pathToFileURL(join(temporary, 'route', version, 'chat/completions/route.js')))])));
  core = await stageCore(dependencies);
  const load = path => import(pathToFileURL(join(core.root, 'src', path)));
  objective = (await load('evals/text/objective.js')).evaluateObjectiveCheck;
  createTextTarget = (await load('targets/text.js')).createTextTarget;
  const { verifyAdmittedFrozenSuite } = await load('evals/text/freeze.js');
  assert.equal(verifyAdmittedFrozenSuite(suite).digest, digest);
});
after(async () => {
  if (original === undefined) delete process.env.TRACK_B_ACCEPTANCE_TOKEN; else process.env.TRACK_B_ACCEPTANCE_TOKEN = original;
  await core?.cleanup(); if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('independent exact accepted all12 artifact digest remains frozen', () => {
  const { digest: stored, ...body } = suite;
  assert.equal(stored, digest);
  assert.equal(createHash('sha256').update(canonical(body)).digest('hex'), digest);
  assert.equal(suite.scenarios.length, 12);
  assert.deepEqual(suite.scenarios.map(s => s.id), Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`));
});

test('all12 fixed completions satisfy actual objective checks and independent factual oracle', async () => {
  const expected = [ /3 projects/, /12 projects/, /Monday through Friday/, /fictional service/, /3 projects/, /12 projects/, /3 projects/, /Monday through Friday/ ];
  for (const [index, scenario] of suite.scenarios.entries()) {
    const response = await routes.fixed.POST(request(payload('fixed', scenario)));
    assert.equal(response.status, 200, scenario.id); privateResponse(response);
    const body = await response.json();
    assert.equal(body.object, 'chat.completion'); assert.equal(body.model, models.fixed);
    assert.equal(body.choices.length, 1); assert.equal(body.choices[0].index, 0);
    assert.equal(body.choices[0].finish_reason, 'stop');
    const message = body.choices[0].message;
    assert.equal(message.role, 'assistant'); assert.equal(typeof message.content, 'string');
    assert.ok(!message.tool_calls?.length); assert.equal(body.usage, undefined, 'fixture must not fabricate provider usage');
    for (const check of scenario.objectiveChecks) assert.equal(objective(check, message.content).status, 'pass', check.id);
    if (index < 8) assert.match(message.content, expected[index], scenario.id);
    else assert.equal(message.content, 'Not specified in the reference.', scenario.id);
    assert.deepEqual(body.controlled_fixture, { origin: 'internal_fixture', status: 'deterministic_canned', version: 'fixed', suite_digest: digest, scenario_id: scenario.id, live_llm: false, remote_prompt_patch_attestation: false });
    assert.equal(response.headers.get('x-track-b-fixture-origin'), 'internal_fixture');
  }
});

test('all12 buggy responses produce objective failure; versions cannot be swapped', async () => {
  for (const scenario of suite.scenarios) {
    const response = await routes.buggy.POST(request(payload('buggy', scenario)));
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.model, models.buggy);
    assert.ok(scenario.objectiveChecks.some(check => objective(check, body.choices[0].message.content).status === 'fail'), scenario.id);
    assert.notEqual(body.choices[0].message.content, (await (await routes.fixed.POST(request(payload('fixed', scenario)))).json()).choices[0].message.content);
  }
  assert.equal((await routes.buggy.POST(request(payload('fixed')))).status, 400);
  assert.equal((await routes.fixed.POST(request(payload('buggy')))).status, 400);
});

test('core Text adapter parses real route response shape without network or provider judge', async () => {
  for (const version of ['buggy', 'fixed']) {
    let calls = 0;
    const target = createTextTarget({ url: 'https://fixture.invalid/completions', model: models[version], apiKey: token, maxCompletionTokens: 512 }, { post: async (_url, body, bearer) => {
      calls++; assert.equal(bearer, token);
      const response = await routes[version].POST(request(body)); assert.equal(response.status, 200); return response.json();
    } });
    const result = await target.send({ scenarioId: 'S01', runId: 'offline-contract', systemPrompt: suite.systemPrompt, userMessage: suite.scenarios[0].userMessage });
    assert.equal(result.ok, true); assert.equal(calls, 1);
  }
});

test('disabled configuration and malformed config fail closed on each request', async () => {
  try {
    for (const value of [undefined, '', ' ', 'contains\nnewline']) {
      if (value === undefined) delete process.env.TRACK_B_ACCEPTANCE_TOKEN; else process.env.TRACK_B_ACCEPTANCE_TOKEN = value;
      await rejected(payload(), 503);
    }
  } finally { process.env.TRACK_B_ACCEPTANCE_TOKEN = token; }
  assert.equal((await routes.fixed.POST(request(payload()))).status, 200);
});

test('auth is independent bearer only and checked before parsing or reading payload', async () => {
  for (const auth of [null, 'Basic sensitive-canary', 'Bearer sensitive-canary', `Bearer ${token}junk`, `bearer ${token}`]) await rejected('sensitive-canary', 401, { auth, raw: true });
  await rejected(payload(), 401, { auth: null, extraHeaders: { cookie: `TRACK_B_ACCEPTANCE_TOKEN=${token}`, 'x-api-key': token } });
  const req = request(); Object.defineProperty(req, 'body', { get() { throw Error('must not read unauthorized body'); } });
  req.headers.delete('authorization'); const response = await routes.fixed.POST(req); assert.equal(response.status, 401);
});

test('revoked or rotated configuration cannot reuse prior authorization', async () => {
  try { process.env.TRACK_B_ACCEPTANCE_TOKEN = `${token}-rotated`; await rejected(payload(), 401); }
  finally { process.env.TRACK_B_ACCEPTANCE_TOKEN = token; }
  assert.equal((await routes.fixed.POST(request())).status, 200);
});

test('malformed and unknown requests use fixed private errors without echo', async () => {
  const cases = [null, [], {}, { ...payload(), model: 'sensitive-canary' }, { ...payload(), surprise: 'sensitive-canary' }, { ...payload(), store: true }, { ...payload(), stream: true }, { ...payload(), tools: [] }, { ...payload(), tool_choice: 'auto' }];
  for (const body of cases) await rejected(body);
  await rejected('{"sensitive-canary":', 400, { raw: true });
  await rejected(payload(), 415, { contentType: 'text/plain' });
  await rejected(payload(), 415, { contentType: null });
});

test('exact system and exactly two known messages prevent generic inference', async () => {
  const cases = [[], [{ role: 'user', content: 'Reply OK.' }], payload().messages.toReversed(), [...payload().messages, { role: 'user', content: 'sensitive-canary' }], [{ role: 'system', content: suite.systemPrompt + ' ' }, payload().messages[1]], [payload().messages[0], { role: 'user', content: suite.scenarios[0].userMessage + ' ' }], [payload().messages[0], { role: 'user', content: ['sensitive-canary'] }], [payload().messages[0], { ...payload().messages[1], tool_calls: [] }]];
  for (const messages of cases) await rejected({ ...payload(), messages });
});

test('completion budget bounded at integer16..512 and store false mandatory', async () => {
  for (const max_completion_tokens of [0, 15, 513, -1, 16.5, '512', null]) await rejected({ ...payload(), max_completion_tokens });
  const missing = payload(); delete missing.max_completion_tokens; await rejected(missing);
  const missingStore = payload(); delete missingStore.store; await rejected(missingStore);
  for (const max_completion_tokens of [16, 512]) assert.equal((await routes.fixed.POST(request({ ...payload(), max_completion_tokens }))).status, 200);
});

test('body bound enforced on actual UTF8 bytes with and without Content-Length', async () => {
  await rejected('x'.repeat(16385), 413, { raw: true });
  await rejected('🧪'.repeat(4097), 413, { raw: true });
  await rejected(payload(), 413, { extraHeaders: { 'content-length': '16385' } });
  await rejected('x'.repeat(16385), 413, { raw: true, extraHeaders: { 'content-length': '1' } });
});

test('non-POST method handlers deny with private fixed errors', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(typeof routes.fixed[method], 'function', method);
    const response = await routes.fixed[method](request(payload(), { method }));
    assert.equal(response.status, 405); privateResponse(response);
  }
});

test('parallel/interleaved versions and scenarios have no state bleed', async () => {
  const jobs = Array.from({ length: 48 }, (_, i) => ({ version: i % 2 ? 'buggy' : 'fixed', scenario: suite.scenarios[i % 12] }));
  const results = await Promise.all(jobs.map(async ({ version, scenario }) => (await (await routes[version].POST(request(payload(version, scenario)))).json()).choices[0].message.content));
  for (let i = 0; i < jobs.length; i++) {
    const { version, scenario } = jobs[i];
    const repeated = await (await routes[version].POST(request(payload(version, scenario)))).json();
    assert.equal(results[i], repeated.choices[0].message.content);
  }
});


test('all denial classes share fixed error envelope; encoding and malformed UTF8 rejected', async () => {
  const unknown = await rejected({ ...payload(), model: 'sensitive-canary' });
  const unauthorized = await rejected(payload(), 401, { auth: null });
  const tooLarge = await rejected('x'.repeat(16385), 413, { raw: true });
  const wrongType = await rejected(payload(), 415, { contentType: 'text/plain' });
  assert.equal(unknown, unauthorized); assert.equal(unknown, tooLarge); assert.equal(unknown, wrongType);
  await rejected(payload(), 415, { extraHeaders: { 'content-encoding': 'gzip' } });
  await rejected(new Uint8Array([0xff, 0xfe]), 400, { raw: true });
});

test('streamed oversized body cancels before accepting trailing fixture input', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16385)); },
    cancel() { cancelled = true; },
  });
  const req = new Request('https://fixture.invalid/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, duplex: 'half' });
  const response = await routes.fixed.POST(req);
  assert.equal(response.status, 413); assert.equal(cancelled, true); privateResponse(response);
});
