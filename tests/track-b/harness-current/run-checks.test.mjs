import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = resolve(dirname(fileURLToPath(import.meta.url)), '../run-checks.mjs');
const parserCandidates = process.env.HARNESS_TYPESCRIPT_DIR ? [process.env.HARNESS_TYPESCRIPT_DIR] : [
  resolve(dirname(runner), 'node_modules/typescript'),
  '/tmp/workflow-bootstrap.JpxCTM/node_modules/typescript',
];
let parser;
for (const candidate of parserCandidates) {
  if (await stat(join(candidate, 'lib/typescript.js')).then(s => s.isFile(), () => false)) { parser = candidate; break; }
}
if (!parser) throw new Error('Set HARNESS_TYPESCRIPT_DIR to an existing TypeScript package directory.');

// These are orchestration tests: fake executables deliberately report green even
// for incomplete results, so a broken fail-closed gate cannot hide behind Vitest.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'track-b-harness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await mkdir(join(root, 'tests/track-b'), { recursive: true });
  await cp(runner, join(root, 'tests/track-b/run-checks.mjs'));
  for (const name of ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges', 'contracts']) {
    await put(`packages/core/src/${name}/index.ts`, 'export {};\n');
  }
  await put('packages/core/src/contracts/services.ts', 'export {};\n');
  await put('packages/core/src/targets/one.test.ts', 'export {};\n');
  await put('packages/core/src/targets/two.test.ts', 'export {};\n');
  await put('existing dependencies/typescript/package.json', await readFile(join(parser, 'package.json')));
  await symlink(join(parser, 'lib'), join(root, 'existing dependencies/typescript/lib'), 'dir');
  await put('existing dependencies/typescript/bin/tsc', `
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
if (config.compilerOptions.strict !== true || config.compilerOptions.noEmit !== true) process.exit(21);
for (const file of JSON.parse(process.env.EXPECT_STAGED ?? '[]')) {
  if (!fs.existsSync(path.resolve('src', file))) { console.error('Missing staged input:', file); process.exit(22); }
}
for (const file of JSON.parse(process.env.FORBID_STAGED ?? '[]')) {
  if (fs.existsSync(path.resolve('src', file))) { console.error('Unexpected staged input:', file); process.exit(23); }
}
for (const [file, content] of Object.entries(JSON.parse(process.env.EXPECT_PACKAGE_CONTENT ?? '{}'))) {
  if (fs.readFileSync(path.resolve('node_modules', file), 'utf8') !== content) { console.error('Wrong staged package:', file); process.exit(25); }
}
`);
  await put('existing dependencies/vitest/package.json', JSON.stringify({ name: 'vitest', version: '4.0.0', type: 'module' }));
  await put('existing dependencies/vitest/vitest.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const files = fs.readdirSync('src/targets').filter(x => /\\.test\\.ts$/.test(x));
const mode = process.env.REPORT_MODE;
const results = files.map((name, index) => ({
  name: path.resolve('src/targets', name), status: 'passed',
  assertionResults: mode === 'empty' && index === 0 ? [] : [{ title: 'required assertion', status: index === 0 && ['skipped', 'todo', 'failed'].includes(mode) ? mode : 'passed' }],
}));
if (mode === 'missing') results.pop();
const report = { numPassedTests: 2, testResults: results };
fs.writeFileSync(process.argv.find(x => x.startsWith('--outputFile.json=')).slice('--outputFile.json='.length), JSON.stringify(report));
if (process.env.EXPECT_CONTRACT_SHA && process.env.TRACK_A_CONTRACT_SHA !== process.env.EXPECT_CONTRACT_SHA) process.exit(24);
`);
  const invoke = (args = [], env = {}) => spawnSync(process.execPath, [join(root, 'tests/track-b/run-checks.mjs'), '--components', 'targets', '--dependency-dir', join(root, 'existing dependencies'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env },
  });
  const commitSource = () => {
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['add', 'packages/core/src']);
    git(['-c', 'user.name=Harness Test', '-c', 'user.email=harness@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  return { root, put, invoke, commitSource };
}

test('existing dependency directory works with spaces and is not mutated', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'existing dependencies/vitest/package.json'), 'utf8');
  const result = f.invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 test files/);
  assert.equal(await readFile(join(f.root, 'existing dependencies/vitest/package.json'), 'utf8'), before);
});

test('fallback supplies missing packages with primary precedence and leaves both trees unchanged', async (t) => {
  const f = await fixture(t);
  const packages = {
    'existing dependencies/duplicate/marker.txt': 'primary',
    'fallback dependencies/duplicate/marker.txt': 'fallback duplicate',
    'fallback dependencies/only-fallback/marker.txt': 'fallback only',
    'fallback dependencies/@scope/extra/marker.txt': 'scoped fallback',
  };
  for (const [path, content] of Object.entries(packages)) await f.put(path, content);
  const result = f.invoke(['--dependency-fallback-dir', join(f.root, 'fallback dependencies')], {
    EXPECT_PACKAGE_CONTENT: JSON.stringify({
      'duplicate/marker.txt': 'primary',
      'only-fallback/marker.txt': 'fallback only',
      '@scope/extra/marker.txt': 'scoped fallback',
    }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [path, content] of Object.entries(packages)) assert.equal(await readFile(join(f.root, path), 'utf8'), content);
});

test('missing fallback directory fails without claiming checks passed', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(['--dependency-fallback-dir', join(f.root, 'missing fallback')]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ENOENT|missing fallback/);
  assert.doesNotMatch(result.stdout, /Strict type-check passed/);
});

for (const mode of ['missing', 'empty', 'failed', 'skipped', 'todo']) {
  test(`green process exit cannot hide ${mode} selected tests`, async (t) => {
    const f = await fixture(t);
    const result = f.invoke([], { REPORT_MODE: mode });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /completeness|coverage|not executed|no tests|skipped|todo|failed/i);
  });
}

test('transitive source and literal resources stage without unselected tests or unrelated resources', async (t) => {
  const f = await fixture(t);
  await f.put('packages/core/src/targets/index.ts', "import '../agents/helper';\n");
  await f.put('packages/core/src/agents/helper.ts', "import '../sandbox/runtime';\n");
  await f.put('packages/core/src/agents/unselected.test.ts', 'throw new Error("must not stage");\n');
  await f.put('packages/core/src/sandbox/runtime.ts', "import './media';\nexport const fixture = new URL('./fixtures/required.json', import.meta.url);\n");
  await f.put('packages/core/src/sandbox/media.ts', 'export {};\n');
  await f.put('packages/core/src/sandbox/fixtures/required.json', '{"retained":true}\n');
  await f.put('packages/core/src/sandbox/fixtures/unrelated.sql', 'must not read or stage\n');
  const result = f.invoke([], {
    EXPECT_STAGED: JSON.stringify(['agents/helper.ts', 'sandbox/runtime.ts', 'sandbox/media.ts', 'sandbox/fixtures/required.json']),
    FORBID_STAGED: JSON.stringify(['agents/unselected.test.ts', 'sandbox/fixtures/unrelated.sql']),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('importing an unselected test fails instead of silently broadening selected coverage', async (t) => {
  const f = await fixture(t);
  await f.put('packages/core/src/targets/index.ts', "import '../agents/unselected.test';\n");
  await f.put('packages/core/src/agents/unselected.test.ts', 'export {};\n');
  const result = f.invoke();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Unselected test imported/);
  assert.doesNotMatch(result.stdout, /Strict type-check passed/);
});

test('unsafe refs and duplicate or unknown options fail before checks', async (t) => {
  const f = await fixture(t);
  for (const args of [['--track-a-ref=--help'], ['--track-a-ref=HEAD\nother'], ['--dependency-dir', f.root], ['--unknown'], ['--components', 'targets']]) {
    const result = f.invoke(args);
    assert.notEqual(result.status, 0, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Strict type-check passed/);
  }
});

test('pinned transitive A blobs override dirty working files and preserve test pin', async (t) => {
  const f = await fixture(t);
  await f.put('packages/core/src/targets/index.ts', "import '../sandbox/runtime';\n");
  await f.put('packages/core/src/sandbox/runtime.ts', "import './media';\n");
  await f.put('packages/core/src/sandbox/media.ts', 'export const pinned = true;\n');
  const sha = f.commitSource();
  await f.put('packages/core/src/sandbox/runtime.ts', "import './dirty-only-missing';\n");
  const result = f.invoke(['--track-a-ref', sha], { EXPECT_CONTRACT_SHA: sha, EXPECT_STAGED: JSON.stringify(['sandbox/runtime.ts', 'sandbox/media.ts']) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(sha));
});

test('missing transitive pinned A file cannot fall back to an uncommitted local file', async (t) => {
  const f = await fixture(t);
  await f.put('packages/core/src/targets/index.ts', "import '../sandbox/runtime';\n");
  await f.put('packages/core/src/sandbox/runtime.ts', "import './local-only';\n");
  const sha = f.commitSource();
  await f.put('packages/core/src/sandbox/local-only.ts', 'export const localOnly = true;\n');
  const result = f.invoke(['--track-a-ref', sha]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Unresolved relative import: sandbox\/runtime.ts: \.\/local-only/);
  assert.doesNotMatch(result.stdout, /Strict type-check passed/);
});
