import { expect, it, vi } from 'vitest';
import { conformanceJobIds, parseConformanceOptions } from './conformance-options';
const strict = ['--strict', '--services', 'real', '--target-url', 'https://target.example/api', '--target-model', 'provider/model'];
it('preserves diagnostic defaults and documented skip modes', () => {
  expect(parseConformanceOptions([], {})).toMatchObject({ services: 'real', strict: false, fixtureJobs: true });
  expect(parseConformanceOptions(['--skip-suite', '--skip-branching'], { EVAL_SERVICES: 'lite' })).toMatchObject({ services: 'lite', skipSuite: true, skipBranching: true });
  expect(parseConformanceOptions(['--services', 'real', '--no-fixture-job'], {})).toMatchObject({ fixtureJobs: false });
  expect(parseConformanceOptions(['--target-url', 'https://target.example'], {})).toMatchObject({ targetModel: undefined });
});
it('accepts strict explicit real or effective real with complete target configuration', () => {
  expect(parseConformanceOptions(strict, {})).toMatchObject({ strict: true, services: 'real' });
  expect(parseConformanceOptions(strict.filter((_, i) => i !== 1 && i !== 2), { EVAL_SERVICES: 'real' })).toMatchObject({ strict: true });
});
it.each([
  ['--services', 'ra el'], ['--services', 'mock'], ['--services'], ['--services', '--strict'], ['--wat'], ['--skip-suite', '--skip-suite'], ['--services', 'real', '--services', 'real'],
  ['--target-url', 'http://target.example'], ['--target-url', 'not-url'], ['--target-url', 'https://user:secret@target.example'], ['--target-url', 'https://target.example/#secret'],
  ['--target-url', 'https://target.example', '--target-key-env', 'KEY-NAME'], ['--target-model', 'model'], ['--target-key-env', 'KEY'],
  ['--target-url', 'https://target.example', '--target-model', 'bad model'],
])('rejects malformed options without echoing input (%j)', (...args) => {
  expect(() => parseConformanceOptions(args, {})).toThrow('Invalid conformance options.');
});
it('rejects incomplete strict acceptance before any external work', () => {
  for (const args of [ ['--strict'], [...strict, '--skip-suite'], [...strict, '--skip-branching'], strict.filter((_, i) => i !== 5 && i !== 6), strict.filter((_, i) => i !== 1 && i !== 2), ['--strict', '--services', 'lite', '--target-url', 'https://target.example', '--target-model', 'model'] ]) {
    expect(() => parseConformanceOptions(args, {})).toThrow();
  }
});
it('shares exactly the strict suite fixture, including concurrent requests', async () => {
  let n = 0; const create = vi.fn(async () => `job-${++n}`); const ids = conformanceJobIds(true, create);
  expect(await Promise.all(['designSuite', 'runSuite', 'investigate', 'rerunFinding'].map(g => ids(g, 'check')))).toEqual(Array(4).fill('job-1'));
  expect(await ids('auditTrace', 'check')).toBe('job-2'); expect(await ids('qualify', 'check')).toBe('job-3');
  expect(create).toHaveBeenCalledTimes(3);
  const diagnostics = conformanceJobIds(false, create);
  expect(await diagnostics('designSuite', 'check')).not.toBe(await diagnostics('runSuite', 'check'));
});
it('imports CLI without executing it and preflights before service loading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const argv = process.argv;
  try {
    const { main } = await import('./conformance');
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    process.argv = ['node', 'conformance.ts', '--strict'];
    await expect(main()).rejects.toThrow('Invalid conformance options.');
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { process.argv = argv; log.mockRestore(); error.mockRestore(); }
});
