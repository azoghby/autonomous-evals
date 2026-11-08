import { afterEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({port:{createSession:vi.fn(),getSession:vi.fn(),listAgentSessions:vi.fn()},runner:{run:vi.fn()},construct:vi.fn()}));
vi.mock('../agents/naive-adapter',()=>({createNaiveClient:vi.fn(()=>({})),createNaiveSessionsPort:()=>mocks.port}));
vi.mock('../agents/session-service',()=>({AgentSessionService:class {constructor(options:unknown){mocks.construct(options);}run=mocks.runner.run;}}));
import { buildAgentDeps,createRealEvalServices,evalServices,NAIVE_AGENT_ENV } from './eval-services';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('factory stays lazy and preserves the existing exported service API',()=>{
 const decorateNaiveSessions=vi.fn();const decorateAgentRunner=vi.fn();
 const service=createRealEvalServices({decorateNaiveSessions,decorateAgentRunner});
 expect(Object.keys(service).sort()).toEqual(Object.keys(evalServices).sort());
 expect(decorateNaiveSessions).not.toHaveBeenCalled();expect(decorateAgentRunner).not.toHaveBeenCalled();expect(mocks.construct).not.toHaveBeenCalled();
});
it('decorates provider before runner construction and returns decorated runner',async()=>{
 vi.stubEnv('NAIVE_API_KEY','offline-test-key');vi.stubEnv('DATABASE_URL','postgres://offline.invalid/app');for(const name of Object.values(NAIVE_AGENT_ENV))vi.stubEnv(name,'offline-agent@1');
 const port={...mocks.port};const runner={run:vi.fn()};const decorateNaiveSessions=vi.fn(()=>port),decorateAgentRunner=vi.fn(()=>runner);
 const deps=await buildAgentDeps({decorateNaiveSessions,decorateAgentRunner});
 expect(decorateNaiveSessions).toHaveBeenCalledWith(mocks.port);expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({naive:port}));expect(decorateAgentRunner).toHaveBeenCalledTimes(1);expect(deps.runner).toBe(runner);
});
