// Host DB/provider bootstrap excluded. The composition itself is the exact Track A blob.
import { composeEvalServices } from '../src/integration/compose';
export { EvalServiceUnavailableError } from '../src/integration/compose';
export { TrackBBlockedError, TrackBPendingError } from '../src/evals/service-adapter';
export class EvalServiceConfigError extends Error {}
export const evalServices = composeEvalServices({ agents: async () => { throw new EvalServiceConfigError('OFFLINE_AGENTS'); }, branches: async () => { throw new EvalServiceConfigError('OFFLINE_BRANCHES'); } });
