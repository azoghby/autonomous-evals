import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const source = join(repo, 'packages/core/src');
const contractsRepoPath = 'packages/core/src/contracts';
const owned = ['agents', 'evals', 'reporting', 'targets', 'simulator', 'monitoring', 'judges'];
/** Compatibility components: tests live in tests/track-b/contract-checks and are staged to src/contract-checks. */
const contractComponents = {
  'contract-schemas': { files: ['schema-compat.test.ts'], needs: [] },
  'contract-targets': { files: ['target-compat.test.ts'], needs: ['targets'] },
  'contract-branches': { files: ['branch-compat.test.ts'], needs: ['simulator'] },
  'contract-evidence': { files: ['evidence-compat.test.ts'], needs: ['judges', 'monitoring'] },
};
const allContract = Object.keys(contractComponents);
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const usage = `Usage: node run-checks.mjs [--components a,b,...] [--track-a-ref <git-ref>] [--dependency-dir <existing-node_modules>] [--dependency-fallback-dir <existing-node_modules>]
Components: ${[...owned, 'contract-checks (all contract-*)', ...allContract].join(', ')}
Omit --components for the full check (every Track B directory plus every compatibility component).
--track-a-ref pins contracts and every imported Track A support blob to that local revision.
--dependency-dir uses an existing node_modules directory (default tests/track-b/node_modules); never installs or mutates it.
--dependency-fallback-dir supplies missing packages only, via links in disposable staging (primary wins).`;

function parseArgs(argv) {
  const parsed = { components: undefined, ref: undefined, dependencyDir: undefined, fallbackDir: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag !== '--components' && flag !== '--track-a-ref' && flag !== '--dependency-dir' && flag !== '--dependency-fallback-dir') throw new Error(`Unknown argument ${JSON.stringify(arg)}.\n${usage}`);
    const key = flag === '--components' ? 'components' : flag === '--dependency-dir' ? 'dependencyDir' : flag === '--dependency-fallback-dir' ? 'fallbackDir' : 'ref';
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
  const { components: spec, ref, dependencyDir: dependencyOption, fallbackDir: fallbackOption } = parseArgs(process.argv.slice(2));
  const selected = selectComponents(spec);
  const selectedSource = selected.filter((name) => owned.includes(name));
  const selectedContract = selected.filter((name) => allContract.includes(name));
  // Only selected directories seed the graph. Imports add individual source files,
  // never entire support directories or their unrelated tests.
  const problems = [];
  for (const name of selectedSource) {
    if (!(await exists(join(source, name)))) problems.push(`Track B source directory not integrated: ${name}`);
    else if (!(await listFiles(join(source, name))).some(file => testFile.test(file))) problems.push(`No test files found in ${name}`);
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

  const dependencyDir = await realpath(resolve(dependencyOption ?? join(here, 'node_modules')));
  // Validate the dependency tree before staging; no fallback or package installation.
  for (const path of ['typescript/package.json', 'typescript/bin/tsc', 'vitest/package.json', 'vitest/vitest.mjs']) {
    const full = join(dependencyDir, path);
    if (path.endsWith('package.json')) JSON.parse(await readFile(full, 'utf8'));
    else if (!await exists(full)) throw new Error(`Missing dependency executable: ${full}`);
  }
  const fallbackDir = fallbackOption ? await realpath(resolve(fallbackOption)) : undefined;
  const ts = createRequire(import.meta.url)(join(dependencyDir, 'typescript'));
  const staging = await mkdtemp(join(tmpdir(), 'ae-track-b-'));
  const stagedTests = [];
  try {
    await mkdir(join(staging, 'src'));
    const queued = [];
    const staged = new Map();
    const pinned = new Map((contracts?.files ?? []).map(file => [`contracts/${file.relative}`, file.content]));
    const aBlobs = new Map();
    const safeRelative = relative => {
      if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relative) || relative.split('/').some(p => p === '..' || p === '.')) throw new Error(`Unsafe source path: ${relative}`);
      const root = relative.split('/')[0].replace(/\.ts$/, '');
      if (![...owned, 'contracts', 'sandbox', 'ai'].includes(root)) throw new Error(`Unaudited source root: ${relative}`);
    };
    const contentAt = async relative => {
      safeRelative(relative);
      if (pinned.has(relative)) return pinned.get(relative);
      const isA = !owned.includes(relative.split('/')[0]);
      if (contracts && isA) {
        const listing = git(['ls-tree', contracts.sha, '--', `packages/core/src/${relative}`]);
        const entry = /^100(?:644|755) blob ([a-f0-9]+)\t[^\n]+\n?$/.exec(listing.stdout);
        if (!entry) return undefined;
        const blob = git(['cat-file', 'blob', entry[1]], 'buffer');
        if (blob.status !== 0) throw new Error(`Cannot read pinned source: ${relative}`);
        aBlobs.set(relative, entry[1]);
        return blob.stdout;
      }
      if (!await exists(join(source, relative))) return undefined;
      return readFile(join(source, relative));
    };
    const enqueue = async relative => {
      if (staged.has(relative)) return;
      const content = await contentAt(relative);
      if (content === undefined) throw new Error(`Missing source dependency: ${relative}`);
      staged.set(relative, content); queued.push(relative);
    };
    for (const directory of selectedSource) {
      for (const file of await listFiles(join(source, directory))) {
        if (!file.endsWith('.ts')) continue;
        const relative = file.slice(source.length + 1);
        await enqueue(relative);
        if (testFile.test(file)) stagedTests.push(join(staging, 'src', relative));
      }
    }
    if (contracts) for (const file of contracts.files) await enqueue(`contracts/${file.relative}`);
    else if (localContracts) for (const file of await listFiles(join(source, 'contracts'))) {
      if (file.endsWith('.ts') && !testFile.test(file)) await enqueue(file.slice(source.length + 1));
    }
    // Compatibility roots participate in the same graph but remain outside core source.
    for (const name of selectedContract) for (const file of contractComponents[name].files) {
      const relative = `contract-checks/${file}`;
      staged.set(relative, await readFile(join(compatDir, file))); queued.push(relative);
    }
    while (queued.length) {
      const relative = queued.shift();
      const text = staged.get(relative).toString('utf8');
      const resolveRelative = specifier => {
        const absolute = resolve('/core', dirname(relative), specifier);
        if (!absolute.startsWith('/core/')) throw new Error(`Import escaped core source: ${relative}: ${specifier}`);
        return absolute.slice('/core/'.length);
      };
      for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        const base = resolveRelative(imported.fileName);
        const stem = base.replace(/\.[cm]?js$/, '');
        const candidates = /\.(?:ts|json)$/.test(base) ? [base] : [`${stem}.ts`, `${stem}/index.ts`];
        let found;
        for (const candidate of candidates) {
          if (testFile.test(candidate) && !stagedTests.includes(join(staging, 'src', candidate))) throw new Error(`Unselected test imported by ${relative}: ${candidate}`);
          if (staged.has(candidate) || await contentAt(candidate) !== undefined) { found = candidate; break; }
        }
        if (!found) throw new Error(`Unresolved relative import: ${relative}: ${imported.fileName}`);
        await enqueue(found);
      }
      // Audited resource shape: literal relative SQL/JSON fixture paths. This also
      // handles the migration array in calendar-integration/services.test.ts.
      for (const match of text.matchAll(/['"](\.[^'"\r\n]*\.(?:sql|json))['"]/g)) {
        // The trace corpus is supplied through TRACE_ACCEPTANCE_PATH below.
        if (relative === 'evals/trace/__tests__/trace-audit.test.ts' && match[1] === '../../../../../../tests/track-b/trace-acceptance.json') continue;
        await enqueue(resolveRelative(match[1]));
      }
    }
    for (const [relative, content] of staged) {
      const destination = join(staging, 'src', relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    console.log(`Source graph: ${staged.size} files; dependencies ${dependencyDir}`);
    if (contracts) console.log(`Pinned Track A support blobs at ${contracts.sha}: ${JSON.stringify(Object.fromEntries([...aBlobs].sort()))}`);
    if (selectedContract.length) {
      await mkdir(join(staging, 'src/contract-checks'), { recursive: true });
      for (const name of selectedContract) {
        for (const file of contractComponents[name].files) {
          await cp(join(compatDir, file), join(staging, 'src/contract-checks', file));
          stagedTests.push(join(staging, 'src/contract-checks', file));
        }
      }
    }
    if (!fallbackDir) await symlink(dependencyDir, join(staging, 'node_modules'), 'dir');
    else {
      // Merge only package links into disposable staging, first directory wins.
      // The existing dependency trees are read-only inputs.
      const linked = new Set();
      for (const directory of [dependencyDir, fallbackDir]) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const names = entry.name.startsWith('@')
            ? (await readdir(join(directory, entry.name))).map(name => `${entry.name}/${name}`)
            : [entry.name];
          for (const name of names) {
            if (linked.has(name)) continue;
            linked.add(name);
            await mkdir(dirname(join(staging, 'node_modules', name)), { recursive: true });
            await symlink(join(directory, name), join(staging, 'node_modules', name), 'dir');
          }
        }
      }
    }
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

    const failures = [];
    const run = (program, args, env = {}) => {
      const result = spawnSync(process.execPath, [program, ...args], { cwd: staging, stdio: 'inherit', env: { ...process.env, ...env } });
      if (result.error) throw result.error;
      if (result.status !== 0) failures.push(`Check ${program} failed with exit ${result.status ?? result.signal}`);
    };
    run(join(dependencyDir, 'typescript/bin/tsc'), ['--project', join(staging, 'tsconfig.json')]);
    const resultsFile = join(staging, 'vitest-results.json');
    // Bound per-harness workers: several agent checkouts may validate concurrently,
    // and each PGlite worker starts its own PostgreSQL WASM instance.
    run(join(dependencyDir, 'vitest/vitest.mjs'), ['run', '--root', staging, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile.json=${resultsFile}`], {
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
    if (incomplete.length) failures.push(`Test completeness check failed:\n${incomplete.map((line) => `- ${line}`).join('\n')}`);
    if (failures.length) throw new Error(failures.join('\n'));
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
