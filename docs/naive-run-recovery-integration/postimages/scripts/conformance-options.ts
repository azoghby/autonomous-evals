/** Pure CLI preflight: never reads credentials or loads services. */
export interface ConformanceCliOptions {
  services: 'real' | 'lite'; strict: boolean; skipBranching: boolean; skipSuite: boolean; fixtureJobs: boolean;
  targetUrl?: string; targetModel?: string; targetKeyEnv?: string; targetSystem?: string;
}
const values = new Set(['--services', '--target-url', '--target-model', '--target-key-env', '--target-system']);
const switches = new Set(['--strict', '--skip-branching', '--skip-suite', '--no-fixture-job']);
export class ConformanceOptionsError extends Error {
  constructor() {
    super('Invalid conformance options. Strict mode requires --services real (or EVAL_SERVICES=real), --target-url https://..., --target-model MODEL, and no skip flags. Use only documented options once, with values where required.');
    this.name = 'ConformanceOptionsError';
  }
}
const invalid = (): never => { throw new ConformanceOptionsError(); };
export function parseConformanceOptions(args: string[], env: Record<string, string | undefined> = process.env): ConformanceCliOptions {
  const found = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (found.has(name) || (!values.has(name) && !switches.has(name))) invalid();
    if (values.has(name)) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) invalid();
      found.set(name, value);
    } else found.set(name, true);
  }
  const get = (name: string) => found.get(name) as string | undefined;
  const explicit = get('--services');
  if (explicit !== undefined && explicit !== 'real' && explicit !== 'lite') invalid();
  const strict = found.has('--strict');
  // Preserve diagnostic defaults; strict requires an intentional real selection.
  const services = explicit ?? (env.EVAL_SERVICES === 'lite' ? 'lite' : 'real');
  const targetUrl = get('--target-url'), targetModel = get('--target-model'), targetKeyEnv = get('--target-key-env');
  if (targetUrl) {
    let url: URL; try { url = new URL(targetUrl); } catch { return invalid(); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || /\s/.test(targetUrl)) invalid();
  }
  if (targetKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(targetKeyEnv)) invalid();
  if (targetModel && (targetModel !== targetModel.trim() || /[\s\x00-\x1f\x7f]/.test(targetModel))) invalid();
  if (!targetUrl && (targetModel || targetKeyEnv || get('--target-system'))) invalid();
  if (strict && ((explicit ?? env.EVAL_SERVICES) !== 'real' || !targetUrl || !targetModel || found.has('--skip-suite') || found.has('--skip-branching'))) invalid();
  return { services: services as 'real' | 'lite', strict, skipBranching: found.has('--skip-branching'), skipSuite: found.has('--skip-suite'), fixtureJobs: services === 'real' && !found.has('--no-fixture-job'), targetUrl, targetModel, targetKeyEnv, targetSystem: get('--target-system') };
}
/** A strict suite is one business operation; unrelated checks retain isolated jobs. */
export function conformanceJobIds(strict: boolean, create: () => Promise<string>): (group: string, name: string) => Promise<string> {
  let suite: Promise<string> | undefined;
  return (group) => strict && ['designSuite', 'runSuite', 'investigate', 'rerunFinding'].includes(group)
    ? (suite ??= create()) : create();
}
