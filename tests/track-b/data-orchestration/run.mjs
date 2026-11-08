import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const here = resolve(testDirectory, '..');
const repo = resolve(here, '../..');
const source = join(repo, 'packages/core/src');
const contractsRepoPath = 'packages/core/src/contracts';
const owned = ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges'];
/** Track B source directories each directory imports at type/runtime level (staged without their tests when unselected). */
const sourceDependencies = { simulator: ['targets'], agents: ['evals', 'reporting'], evals: ['agents', 'reporting', 'simulator', 'judges'], reporting: ['agents', 'evals'] };
/** Compatibility components: tests live in tests/track-b/contract-checks and are staged to src/contract-checks. */
const contractComponents = {
  'contract-schemas': { files: ['schema-compat.test.ts'], needs: [] },
  'contract-targets': { files: ['target-compat.test.ts'], needs: ['targets'] },
  'contract-branches': { files: ['branch-compat.test.ts'], needs: ['simulator'] },
  'contract-evidence': { files: ['evidence-compat.test.ts'], needs: ['judges', 'monitoring'] },
};
const allContract = Object.keys(contractComponents);
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const usage = `Usage: node run-checks.mjs [--components a,b,...] [--track-a-ref <git-ref>]
Components: ${[...owned, 'contract-checks (all contract-*)', ...allContract].join(', ')}
Omit --components for the full check (every Track B directory plus every compatibility component).
--track-a-ref reads packages/core/src/contracts from that exact, already-fetched local git revision.`;

function parseArgs(argv) {
  const parsed = { components: undefined, ref: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag !== '--components' && flag !== '--track-a-ref') throw new Error(`Unknown argument ${JSON.stringify(arg)}.\n${usage}`);
    const key = flag === '--components' ? 'components' : 'ref';
    if (parsed[key] !== undefined) throw new Error(`${flag} was supplied more than once.`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') throw new Error(`${flag} requires a value.`);
    parsed[key] = value;
  }
  return parsed;
}

function selectComponents(spec) {
  if (spec === undefined) return [...owned, ...allContract];
  const names = spec.split(',').map((name) => name.trim()).filter(Boolean);
  const expanded = names.flatMap((name) => (name === 'contract-checks' ? allContract : [name]));
  const unknown = expanded.filter((name) => !owned.includes(name) && !allContract.includes(name));
  if (!expanded.length || unknown.length) {
    throw new Error(`Unknown or empty component selection${unknown.length ? `: ${unknown.join(', ')}` : ''}.\n${usage}`);
  }
  return [...new Set(expanded)];
}

/** Argument-vector git only; user text is never interpolated into a shell command. */
function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd: repo, shell: false, encoding, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) throw result.error;
  return result;
}

/** Resolve a local revision; this never fetches. Returns the exact commit SHA and the contract blobs at that SHA. */
function readContractsFromRef(ref) {
  if (ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('--track-a-ref must be a git revision, not an option or multiline text.');
  const resolved = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = resolved.stdout.trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`Track A ref ${JSON.stringify(ref)} is not a locally available commit. Fetch it first (for example: git fetch origin track-a); this check does not fetch.`);
  }
  const listing = git(['ls-tree', '-r', '-z', '--full-tree', sha, '--', contractsRepoPath]);
  if (listing.status !== 0) throw new Error(`Could not list ${contractsRepoPath} at ${sha}.`);
  const files = [];
  for (const entry of listing.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Unrecognized git tree entry.');
    const [, mode, type, object, path] = match;
    if (!path.endsWith('.ts') || testFile.test(path)) continue;
    const relative = path.slice(contractsRepoPath.length + 1);
    if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(relative) || relative.split('/').includes('..')) {
      throw new Error(`Refusing unsafe contract path ${JSON.stringify(path)}.`);
    }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new Error(`Refusing non-regular contract entry ${JSON.stringify(path)}.`);
    const blob = git(['cat-file', 'blob', object], 'buffer');
    if (blob.status !== 0) throw new Error(`Could not read ${path} at ${sha}.`);
    files.push({ relative, content: blob.stdout });
  }
  for (const required of ['index.ts', 'services.ts']) {
    if (!files.some((file) => file.relative === required)) throw new Error(`Track A revision ${sha} has no ${contractsRepoPath}/${required}.`);
  }
  const digest = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relative.localeCompare(b.relative))) digest.update(file.relative).update('\0').update(file.content).update('\0');
  return { sha, ref, digest: digest.digest('hex'), files };
}

async function listFiles(directory) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk(directory);
  return found;
}

const exists = (path) => stat(path).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));

async function main() {
  const { components: spec, ref } = parseArgs(process.argv.slice(2));
  const selected = selectComponents(spec);
  const selectedSource = selected.filter((name) => owned.includes(name));
  const selectedContract = selected.filter((name) => allContract.includes(name));
  // Follow transitive imports; cycles among agents/evals/reporting are intentional.
  const required = new Set(selectedSource);
  const pending = [...selectedSource, ...selectedContract.flatMap(name => contractComponents[name].needs)];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name); required.add(name);
    pending.push(...(sourceDependencies[name] ?? []));
  }
  const support = [...required].filter(name => !selectedSource.includes(name));

  // Fail before staging when any required input is absent. Nothing is skipped silently.
  const problems = [];
  for (const name of [...selectedSource, ...support]) {
    if (!(await exists(join(source, name)))) problems.push(`Track B source directory not integrated: ${name}`);
  }
  for (const name of selectedSource) {
    if (!problems.some((problem) => problem.endsWith(`: ${name}`)) && !(await listFiles(join(source, name))).some((file) => testFile.test(file))) {
      problems.push(`No test files found in ${name}`);
    }
  }
  const compatDir = join(here, 'contract-checks');
  for (const name of selectedContract) {
    for (const file of contractComponents[name].files) {
      if (!(await exists(join(compatDir, file)))) problems.push(`Missing compatibility test ${name}: contract-checks/${file}`);
    }
  }
  const localContracts = await exists(join(source, 'contracts'));
  if (selectedContract.length && !ref && !localContracts) {
    problems.push('Shared contracts unavailable: pass --track-a-ref <git-ref> (for example origin/track-a) or integrate packages/core/src/contracts');
  }
  let contracts;
  if (ref) {
    try { contracts = readContractsFromRef(ref); } catch (error) { problems.push(error.message); }
  }
  if (problems.length) {
    console.error(`${problems.map((problem) => `- ${problem}`).join('\n')}\nNo checks passed.`);
    process.exit(1);
  }

  const staging = await mkdtemp(join(tmpdir(), 'ae-track-b-'));
  const stagedTests = [];
  try {
    await mkdir(join(staging, 'src'));
    for (const directory of selectedSource) {
      await cp(join(source, directory), join(staging, 'src', directory), { recursive: true });
      for (const file of await listFiles(join(staging, 'src', directory))) if (testFile.test(file)) stagedTests.push(file);
    }
    const extra = join(staging, 'src/evals/data/orchestration-tests');
    await cp(testDirectory, extra, { recursive: true, filter: path => !path.endsWith('.mjs') });
    for (const file of await listFiles(extra)) if (testFile.test(file)) stagedTests.push(file);
    for (const directory of support) {
      await cp(join(source, directory), join(staging, 'src', directory), { recursive: true, filter: (path) => !testFile.test(path) });
    }
    if (contracts) {
      for (const file of contracts.files) {
        const destination = join(staging, 'src/contracts', file.relative);
        if (!destination.startsWith(join(staging, 'src/contracts') + sep)) throw new Error('Contract path escaped staging.');
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content);
      }
    } else if (localContracts) {
      await cp(join(source, 'contracts'), join(staging, 'src/contracts'), { recursive: true, filter: (path) => !testFile.test(path) });
    }
    if (selectedContract.length) {
      await mkdir(join(staging, 'src/contract-checks'));
      for (const name of selectedContract) {
        for (const file of contractComponents[name].files) {
          await cp(join(compatDir, file), join(staging, 'src/contract-checks', file));
          stagedTests.push(join(staging, 'src/contract-checks', file));
        }
      }
    }
    await symlink(join(here, 'node_modules'), join(staging, 'node_modules'), 'dir');
    await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(staging, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
        resolveJsonModule: true, isolatedModules: true, types: ['node'],
      },
      include: ['src/**/*.ts'],
    }));

    const contractSource = contracts
      ? `git revision ${contracts.sha} (requested ${JSON.stringify(contracts.ref)}; contract digest sha256:${contracts.digest})`
      : localContracts ? 'local working tree packages/core/src/contracts (no revision recorded)' : 'none';
    console.log(`Shared contracts: ${contractSource}`);

    const run = (program, args, env = {}) => {
      const result = spawnSync(process.execPath, [program, ...args], { cwd: staging, stdio: 'inherit', env: { ...process.env, ...env } });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Check failed with exit ${result.status ?? result.signal}`);
    };
    run(join(here, 'node_modules/typescript/bin/tsc'), ['--project', join(staging, 'tsconfig.json')]);
    const resultsFile = join(staging, 'vitest-results.json');
    // Bound per-harness workers: several agent checkouts may validate concurrently,
    // and each PGlite worker starts its own PostgreSQL WASM instance.
    run(join(here, 'node_modules/vitest/vitest.mjs'), ['run', '--root', staging, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile.json=${resultsFile}`], {
      TRACK_A_CONTRACT_SHA: contracts?.sha ?? '',
      TRACE_ACCEPTANCE_PATH: join(here, 'trace-acceptance.json'),
    });

    // A green exit alone is insufficient: every staged test file must have run, with no skipped/todo tests.
    const report = JSON.parse(await readFile(resultsFile, 'utf8'));
    const realStaging = await realpath(staging);
    const byFile = new Map(report.testResults.map((entry) => [entry.name, entry]));
    const incomplete = [];
    let knownGaps = 0;
    for (const file of stagedTests) {
      const entry = byFile.get(file) ?? byFile.get(file.replace(staging, realStaging));
      const label = file.slice(staging.length + 1);
      if (!entry) incomplete.push(`${label}: not executed`);
      else if (!entry.assertionResults.length) incomplete.push(`${label}: no tests`);
      else if (entry.status !== 'passed' || entry.assertionResults.some((test) => test.status !== 'passed')) incomplete.push(`${label}: failed, skipped, or todo tests`);
      else knownGaps += entry.assertionResults.filter((test) => test.title.startsWith('KNOWN GAP')).length;
    }
    if (incomplete.length) throw new Error(`Test completeness check failed:\n${incomplete.map((line) => `- ${line}`).join('\n')}`);
    console.log(`Track B checked components: ${selected.join(', ')}. Strict type-check passed; ${stagedTests.length} test files, ${report.numPassedTests} tests passed, none skipped.`);
    if (selectedContract.length) {
      console.log(`Documented Track A contract gaps asserted as still open: ${knownGaps}. A failing KNOWN GAP test means the contract changed; update docs/track-b-contract-compatibility.md and the check together. Live-provider checks are separate.`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
