export async function getJobWithDecryptedCredentials(){return (globalThis as any).__workflowLoaded;}
export async function recordCost(){throw new Error('No provider costs permitted in canonical tests');}
export async function buildAgentDeps(){return {runner:{run:async()=>{throw new Error('No provider dispatch permitted');}}};}
export const evalServices={getJobBranchConnection:async()=>{throw new Error('No branch connection permitted');}};
export class Pool {
 constructor(_options:unknown){}
 query(q:string,p?:unknown[]){return (globalThis as any).__workflowPg.query(q,p);}
 async connect(){return {query:this.query.bind(this),release(){}};}
}
