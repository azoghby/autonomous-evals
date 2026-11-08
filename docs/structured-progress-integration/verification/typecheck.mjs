import {mkdtempSync,cpSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const stage=process.argv[2];if(!stage)throw new Error('Usage: node typecheck.mjs VALIDATED_STAGE [EXISTING_NODE_MODULES]');
const deps=resolve(process.argv[3]??process.env.STRUCTURED_NODE_MODULES??'/tmp/track-b-harness/node_modules');
const scratch=mkdtempSync(join(tmpdir(),'structured-progress-ts-'));
cpSync(join(stage,'packages'),join(scratch,'packages'),{recursive:true});
cpSync(join(stage,'apps/web/src/server'),join(scratch,'apps/web/src/server'),{recursive:true});
symlinkSync(deps,join(scratch,'node_modules'),'dir');
writeFileSync(join(scratch,'apps/web/src/server/session.ts'),'export declare function getCurrentCustomer():Promise<{id:string;isOperator:boolean}|null>;\n');
writeFileSync(join(scratch,'offline.d.ts'),`declare module 'server-only';
declare module '@neondatabase/serverless' {interface Client {query(sql:string,params?:unknown[]):Promise<{rows:unknown[]}>;release():void;} export class Pool {constructor(options:{connectionString:string;max:number;connectionTimeoutMillis:number;idleTimeoutMillis:number});connect():Promise<Client>;query(sql:string,params?:unknown[]):Promise<{rows:unknown[]}>;}}
`);
writeFileSync(join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],baseUrl:'.',paths:{'@ae/core/*':['packages/core/src/*']}},include:['offline.d.ts','apps/web/src/server/progress-chat.ts','apps/web/src/server/structured-progress.ts','apps/web/src/server/structured-progress-inventory.ts']},null,2));
console.log(`Targeted TypeScript scratch: ${scratch}; actual applied app/core sources; offline Neon/session declarations, not full workspace or real SDK.`);
execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p',join(scratch,'tsconfig.json')],{cwd:scratch,stdio:'inherit'});
console.log('Targeted strict TypeScript passed.');
