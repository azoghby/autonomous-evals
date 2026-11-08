import {mkdtemp,cp,symlink,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const stage=process.argv[2],deps=process.argv[3];
if(!stage||!deps)throw new Error('Usage: node typecheck.mjs PATCHED_STAGE EXISTING_NODE_MODULES');
const scratch=await mkdtemp(path.join(os.tmpdir(),'progress-chat-server-ts-'));
await symlink(path.resolve(deps),path.join(scratch,'node_modules'),'dir');
for(const dir of ['apps/web/src/server','apps/web/src/app/api/jobs/[jobId]/chat','packages/core/src/reporting/chat','packages/core/src/storage','packages/core/src/agents','packages/core/src/evals'])await mkdir(path.join(scratch,dir),{recursive:true});
for(const file of ['apps/web/src/server/progress-chat.ts','apps/web/src/app/api/jobs/[jobId]/chat/route.ts','packages/core/src/storage/crypto.ts','packages/core/src/agents/redact.ts','packages/core/src/evals/types.ts'])await cp(path.join(stage,file),path.join(scratch,file));
await cp(path.join(stage,'packages/core/src/reporting/chat'),path.join(scratch,'packages/core/src/reporting/chat'),{recursive:true});
await writeFile(path.join(scratch,'apps/web/src/server/session.ts'),'export declare function getCurrentCustomer(): Promise<{id:string;isOperator:boolean}|null>;\n');
await writeFile(path.join(scratch,'offline.d.ts'),`declare module 'server-only';
declare module '@neondatabase/serverless' {
 interface Client { query(sql:string, params?:unknown[]):Promise<{rows:unknown[]}>;release():void; }
 export class Pool {constructor(options:{connectionString:string;max:number;connectionTimeoutMillis:number;idleTimeoutMillis:number});connect():Promise<Client>;query(sql:string,params?:unknown[]):Promise<{rows:unknown[]}>;}
}\n`);
await writeFile(path.join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,types:['node'],baseUrl:'.',paths:{'@/*':['apps/web/src/*'],'@ae/core/*':['packages/core/src/*.ts']}},include:['offline.d.ts','apps/web/src/server/progress-chat.ts','apps/web/src/app/api/jobs/[jobId]/chat/route.ts']},null,2));
const run=spawnSync(path.join(deps,'.bin/tsc'),['-p',path.join(scratch,'tsconfig.json')],{cwd:scratch,stdio:'inherit'});
console.log('Retained targeted server typecheck:',scratch);process.exit(run.status??1);
