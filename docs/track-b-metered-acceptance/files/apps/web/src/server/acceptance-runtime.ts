import 'server-only';
import { randomUUID } from 'node:crypto';
import type { JsonTransport } from '@ae/core/targets/transport';
import type { NaiveSessionsPort } from '@ae/core/evals/types';
import type { TrustedJudgeRuntime } from './rich-judge';

/** Internal construction authority only. No HTTP parser accepts this runtime.
 * The durable meter reserves attempts; existing provider accounting owns money.
 * An injected target/Naive fetch must honor signal; production uses native fetch
 * for SDK and HttpsJsonTransport({signal}) for targets. Never Promise.race abort.
 */
export interface AcceptanceRuntime {
  signal: AbortSignal;
  beforeDispatch(intent: {kind:'target'|'gateway'|'naive';operationId:string}): Promise<void>;
}
export function acceptancePorts(runtime: AcceptanceRuntime) {
  async function admit(kind:'target'|'gateway'|'naive', operationId = `${kind}:${randomUUID()}`) {
    runtime.signal.throwIfAborted();
    await runtime.beforeDispatch({kind,operationId});
    runtime.signal.throwIfAborted();
  }
  return {
    judge(base: TrustedJudgeRuntime): TrustedJudgeRuntime {
      return {...base, signal:AbortSignal.any([runtime.signal,base.signal]), beforeDispatch: async intent=>{
        // Preserve production per-phase/per-operation policy; acceptance cannot enlarge it.
        await base.beforeDispatch(intent); await admit('gateway',intent.operationId);
      }};
    },
    target(base:JsonTransport):JsonTransport {
      return {post:async (...args)=>{await admit('target');return base.post(...args);}};
    },
    sessions(base:NaiveSessionsPort):NaiveSessionsPort {
      return {
        createSession:async (...args)=>{await admit('naive');return base.createSession(...args);},
        getSession:async (...args)=>{await admit('naive');return base.getSession(...args);},
        listAgentSessions:async (...args)=>{await admit('naive');return base.listAgentSessions(...args);},
      };
    },
    fetch(base:typeof fetch = fetch):typeof fetch {
      return async (input,init)=>{runtime.signal.throwIfAborted();return base(input,{...init,signal:init?.signal?AbortSignal.any([runtime.signal,init.signal]):runtime.signal});};
    },
  };
}
