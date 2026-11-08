import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stageJudging } from '../workflow-judging-integration/stage.mjs';
import { applyRemediation } from '../controlled-remediation-targets/stage.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
// Exact preimages; refuse upstream drift, never overwrite owner's checkout.
export async function stageMetered() {
 const result=await stageJudging(), {stage}=result;
 applyRemediation(stage);
 const changes=[];
 function edit(path, edits) {
   let source=readFileSync(join(stage,path),'utf8'); const before=createHash('sha256').update(source).digest('hex');
   for(const [from,to] of edits) { if(source.split(from).length!==2) throw Error('Preimage mismatch: '+path+': '+from); source=source.replace(from,to); }
   writeFileSync(join(stage,path),source);changes.push({path,before,after:createHash('sha256').update(source).digest('hex')});
 }
 const server='apps/web/src/server/';
 mkdirSync(join(stage,server),{recursive:true});copyFileSync(join(here,'files',server,'acceptance-runtime.ts'),join(stage,server,'acceptance-runtime.ts'));
 edit('packages/core/src/targets/transport.ts',[
   ['export interface TransportOptions {','export interface TransportOptions {\n  signal?: AbortSignal;'],
   ['const controller = new AbortController();','const controller = new AbortController();\n      const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;\n      signal.throwIfAborted();'],
   ['if (controller.signal.aborted) throw','if (signal.aborted) throw'],
   ['signal: controller.signal,','signal,'],
 ]);
 edit('packages/core/src/integration/eval-services.ts',[
   ['export async function buildAgentDeps(): Promise<TrackBServiceDeps> {','export async function buildAgentDeps(runtime?: { fetch: typeof fetch; sessions(port: import("../evals/types").NaiveSessionsPort): import("../evals/types").NaiveSessionsPort }): Promise<TrackBServiceDeps> {'],
   ['createNaiveClient({ apiKey: env.NAIVE_API_KEY,','createNaiveClient({ fetch: runtime?.fetch, apiKey: env.NAIVE_API_KEY,'],
   ['const naive = createNaiveSessionsPort(client);','const rawNaive = createNaiveSessionsPort(client);\n  const naive = runtime ? runtime.sessions(rawNaive) : rawNaive;'],
 ]);
 edit(server+'rich-services.ts',[
   ["import 'server-only';","import 'server-only';\nimport { acceptancePorts, type AcceptanceRuntime } from './acceptance-runtime';\nimport { HttpsJsonTransport } from '@ae/core/targets/transport';"],
   ['judgeRuntime?: TrustedJudgeRuntime }','judgeRuntime?: TrustedJudgeRuntime; acceptanceRuntime?: AcceptanceRuntime }'],
   ['const judgeRuntime = authority.judgeRuntime ?? workflowJudgeRuntime();','const ports = authority.acceptanceRuntime ? acceptancePorts(authority.acceptanceRuntime) : undefined;\n  const baseJudgeRuntime = authority.judgeRuntime ?? workflowJudgeRuntime();\n  const judgeRuntime = ports ? ports.judge(baseJudgeRuntime) : baseJudgeRuntime;\n  const transport = ports?.target(new HttpsJsonTransport({signal: authority.acceptanceRuntime!.signal}));'],
   ['const agentDeps = await buildAgentDeps();','const agentDeps = await buildAgentDeps(ports ? {fetch:ports.fetch(),sessions:ports.sessions} : undefined);'],
   ['createTextTarget(a.intake.endpoint), targetVersion:','createTextTarget({...a.intake.endpoint,...(authority.acceptanceRuntime ? {maxCompletionTokens:512} : {})}, transport), targetVersion:'],
   ['canonical, text, judge });','canonical, text, judge, transport });'],
   ['platformTarget(a.intake.endpoint) }','platformTarget(a.intake.endpoint, transport) }'],
   ['target: createTextTarget(a.intake.endpoint), knownSecrets:','target: createTextTarget({...a.intake.endpoint,...(authority.acceptanceRuntime ? {maxCompletionTokens:512} : {})}, transport), knownSecrets:'],
 ]);
 edit(server+'rich-remediation.ts',[
   ["import 'server-only';","import 'server-only';\nimport type { JsonTransport } from '@ae/core/targets/transport';"],
   ['judge?: ReturnType<typeof createTrustedJudgeResolver>;','judge?: ReturnType<typeof createTrustedJudgeResolver>;\n  transport?: JsonTransport;'],
   ['    }) : null;','      transport: deps.transport,\n    }) : null;'],
 ]);
 return {...result,changes,live:false};
}
