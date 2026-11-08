// Offline review of an immutable source tree. Characterizations are NOT acceptance criteria.
// Run: node --test tests/track-b/loopback-transport-review/review.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const path = require('node:path');
const deps = process.env.LOOPBACK_REVIEW_DEPS || '/tmp/sandbox-generation-deps.cBCEai/node_modules';
const ts = require(path.join(deps, 'typescript'));
const PIN = '72d523bf2f213163b3fd2a62f5a24cbf6c838e8d';
const root = path.resolve(__dirname, '../../..');
const sources = new Map();
function source(file) {
  if (!sources.has(file)) sources.set(file, execFileSync('git', ['show', `${PIN}:${file}`], { cwd: root, timeout: 30_000, encoding: 'utf8' }));
  return sources.get(file);
}
function load(file, mocks = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const requireMock = name => name in mocks ? mocks[name] : name.startsWith('node:') ? require(name) : require(path.join(deps, name));
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', { Buffer, URL, AbortController, setTimeout, clearTimeout, console }, { filename: `${PIN}/${file}`, timeout: 1000 })(requireMock, module, module.exports);
  return module.exports;
}
const transportFile = 'packages/core/src/targets/transport.ts';
function harness(options = {}) {
  const calls = [];
  const request = (opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = payload => { req.payload = payload; };
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, destroyed: false, destroy() { this.destroyed = true; } });
    calls.push({ opts, req, res, respond: () => cb(res) });
    return req;
  };
  const mod = load(transportFile, { 'node:http': { request }, 'node:https': { request: () => { throw new Error('external HTTPS prohibited'); } } });
  return { ...mod, calls, client: new mod.LoopbackJsonTransport(options) };
}
const endpoint = 'http://127.0.0.1:8123/v1/chat/completions';
const code = expected => e => e.code === expected;

test('safe control: only canonical loopback destination, HTTP, explicit nondefault port, no credentials/query/fragment', async () => {
  const h = harness();
  for (const url of ['https://127.0.0.1:8123/x', 'http://localhost:8123/x', 'http://127.0.0.2:8123/x', 'http://[::1]:8123/x', 'http://10.0.0.1:8123/x', 'http://example.com:8123/x', 'http://user:pass@127.0.0.1:8123/x', endpoint + '?x=1', endpoint + '#x', 'bad']) {
    await assert.rejects(h.client.post(url, {}), code('blocked_address'));
  }
  assert.equal(h.calls.length, 0);
  // WHATWG normalization of unusual numeric spelling stays on exactly 127.0.0.1.
  assert.equal(h.isLoopbackEndpoint('http://2130706433:8123/x'), true);
});
test('safe control: successful JSON, byte-accurate content length, no pooling, pinned host', async () => {
  const h = harness();
  const p = h.client.post(endpoint, { text: 'é' }, 'operator-key');
  const c = h.calls[0];
  assert.equal(c.opts.hostname, '127.0.0.1');
  assert.equal(c.opts.agent, false);
  assert.equal(c.opts.headers['Content-Length'], Buffer.byteLength(c.req.payload));
  assert.equal(c.opts.headers.Authorization, 'Bearer operator-key');
  c.respond(); c.res.emit('data', Buffer.from('{"ok":true}')); c.res.emit('end');
  assert.equal((await p).ok, true);
});
test('safe control: bounded response destroys stream at first excess byte', async () => {
  const h = harness({ maxResponseBytes: 2 });
  const p = h.client.post(endpoint, {});
  const c = h.calls[0]; c.respond(); c.res.emit('data', Buffer.from('123'));
  await assert.rejects(p, code('response_too_large'));
  assert.equal(c.res.destroyed, true);
});
test('safe control: redirects refused without a second request', async () => {
  const h = harness(); const p = h.client.post(endpoint, {});
  const c = h.calls[0]; c.res.statusCode = 302; c.res.headers.location = 'https://example.com'; c.respond();
  await assert.rejects(p, code('provider_http_error'));
  assert.equal(c.res.destroyed, true); assert.equal(h.calls.length, 1);
});
test('safe control: circular/BigInt serialization errors stay local', async () => {
  const h = harness(); const circular = {}; circular.self = circular;
  for (const body of [circular, 1n]) await assert.rejects(h.client.post(endpoint, body), code('invalid_request'));
  assert.equal(h.calls.length, 0);
});
test('safe control: malformed response and request/response errors settle', async () => {
  for (const kind of ['json', 'request', 'response', 'timeout']) {
    const h = harness(); const p = h.client.post(endpoint, {}); const c = h.calls[0];
    if (kind === 'request') c.req.emit('error', new Error('connection refused'));
    else if (kind === 'timeout') c.req.emit('timeout');
    else { c.respond(); if (kind === 'response') c.res.emit('error', new Error('aborted')); else { c.res.emit('data', Buffer.from('bad')); c.res.emit('end'); } }
    await assert.rejects(p, code(kind === 'json' ? 'invalid_json' : kind === 'timeout' ? 'timeout' : 'transport_error'));
    if (kind === 'timeout') assert.equal(c.req.destroyed, true);
  }
});
test('CHARACTERIZATION: undefined/function/symbol JSON result rejects with raw TypeError', async () => {
  const h = harness();
  for (const body of [undefined, () => {}, Symbol('x'), { toJSON: () => undefined }]) await assert.rejects(h.client.post(endpoint, body), e => e.name === 'TypeError' && e.code === 'ERR_INVALID_ARG_TYPE');
  assert.equal(h.calls.length, 0);
});
test('CHARACTERIZATION: no request byte bound (HTTPS default is 256000)', async () => {
  const h = harness(); const body = { text: 'x'.repeat(256_001) };
  const p = h.client.post(endpoint, body); const c = h.calls[0];
  assert.ok(c.opts.headers['Content-Length'] > 256_000);
  c.req.emit('error', new Error('test cleanup'));
  await assert.rejects(p, code('transport_error'));
  await assert.rejects(new h.HttpsJsonTransport().post('https://example.com/v1', body), code('request_too_large'));
});
test('CHARACTERIZATION: invalid credentials are forwarded without HTTPS credential validation', async () => {
  for (const bearer of ['', 'contains space', 'x'.repeat(8193)]) {
    const h = harness(); const p = h.client.post(endpoint, {}, bearer); const c = h.calls[0];
    assert.equal(c.opts.headers.Authorization, bearer ? `Bearer ${bearer}` : undefined);
    c.req.emit('error', new Error('test cleanup')); await assert.rejects(p, code('transport_error'));
    await assert.rejects(new h.HttpsJsonTransport().post('https://example.com/v1', {}, bearer), code('invalid_credential'));
  }
});
test('CHARACTERIZATION: compressed bytes report invalid_json, mislabeled plaintext is accepted', async () => {
  const { gzipSync } = require('node:zlib');
  for (const compressed of [true, false]) {
    const h = harness(); const p = h.client.post(endpoint, {}); const c = h.calls[0];
    c.res.headers['content-encoding'] = 'gzip'; c.respond();
    c.res.emit('data', compressed ? gzipSync('{}') : Buffer.from('{}')); c.res.emit('end');
    if (compressed) await assert.rejects(p, code('invalid_json')); else await p;
  }
});
test('CHARACTERIZATION: timeoutMs is inactivity only; progress runs beyond deadline (disposable loopback)', { timeout: 3000 }, async () => {
  const http = require('node:http');
  const mod = load(transportFile);
  const timers = new Set();
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"x":"');
    const drip = setInterval(() => res.write('x'), 5); timers.add(drip);
    const end = setTimeout(() => { clearInterval(drip); res.end('"}'); }, 180); timers.add(end);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const start = performance.now();
    const reply = await new mod.LoopbackJsonTransport({ timeoutMs: 60 }).post(`http://127.0.0.1:${server.address().port}/x`, {});
    assert.equal(typeof reply.x, 'string'); assert.ok(performance.now() - start >= 150, 'completed well beyond 60ms');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
test('safe control: actual Node header validation rejects CRLF before connecting', async () => {
  const mod = load(transportFile);
  await assert.rejects(new mod.LoopbackJsonTransport().post(endpoint, {}, 'key\r\nInjected: value'), e => e.code === 'ERR_INVALID_CHAR');
});

test('safe control: native idle timeout and mid-response socket abort reject and release sockets', { timeout: 3000 }, async () => {
  const http = require('node:http');
  const mod = load(transportFile);
  for (const kind of ['idle', 'abort']) {
    const sockets = new Set(); const timers = new Set();
    const server = http.createServer((_req, res) => {
      if (kind === 'abort') {
        res.writeHead(200); res.write('{"partial":');
        timers.add(setTimeout(() => res.socket?.destroy(), 5));
      }
    });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(new mod.LoopbackJsonTransport({ timeoutMs: 60 }).post(`http://127.0.0.1:${server.address().port}/`, {}), code(kind === 'idle' ? 'timeout' : 'transport_error'));
      // Observe the peer's close after rejection rather than forcing it to make the test pass.
      await new Promise((resolve, reject) => {
        const check = () => { if (sockets.size === 0) { clearTimeout(guard); resolve(); } };
        const guard = setTimeout(() => reject(new Error('peer socket remained open')), 300);
        for (const socket of sockets) socket.on('close', check);
        check();
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('safe controls: default lite deps secure; allowLoopback only bypasses validation when explicitly true', async () => {
  const h = harness();
  const gateway = {};
  const depsMod = load('packages/core/src/lite/deps.ts', { '../ai/gateway': gateway, '../targets/transport': h });
  assert.equal(depsMod.defaultLiteDeps().allowLoopback, undefined);
  assert.ok(depsMod.defaultLiteDeps().transport instanceof h.HttpsJsonTransport);
  let calls = 0;
  const run = load('packages/core/src/lite/run.ts', {
    '../ai/gateway': gateway,
    '../contracts/index': {},
    '../targets/transport': h,
    '../targets/chat': { ChatCompletionsClient: class { async checkTarget() { calls++; } async complete() { return { role: 'assistant', content: 'local reply' }; } } },
    '../redteam/select': { isRedTeamScenarioId: () => true, renderRedTeamTurns: () => ['hello'], plantedSystemPrompt: () => '', gradeRedTeamResponse: () => ({ passed: true, failedRules: [] }) }, './deps': depsMod,
  });
  for (const allowLoopback of [undefined, false, true]) {
    const services = run.createRunServices(depsMod.defaultLiteDeps({ allowLoopback }), new depsMod.TargetRegistry());
    const result = await services.checkTarget({}, { url: endpoint, model: 'local' });
    assert.equal(result.ok, allowLoopback === true);
    if (!allowLoopback) assert.equal(result.detail, 'invalid_endpoint');
    const rejected = await services.checkTarget({}, { url: 'http://10.0.0.1:8123/x', model: 'local' });
    assert.equal(rejected.ok, false);
    const resultRun = await services.runSuite({ jobId: 'offline-job', budgetMicroUsd: 100_000, recordCost: async () => {}, recordProgress: async () => {} },
      { versionLabel: 'offline', scenarios: [{ id: 'offline-redteam', input: 'hello', category: 'test', checks: [] }] },
      { url: endpoint, model: 'local', systemPrompt: '' });
    const detail = depsMod.decodeDetail(resultRun.results[0].detail);
    assert.equal(detail.grader, allowLoopback === true ? 'redteam' : 'error');
    if (!allowLoopback) assert.equal(detail.reason, 'invalid_endpoint');
  }
  assert.equal(calls, 1);
});
