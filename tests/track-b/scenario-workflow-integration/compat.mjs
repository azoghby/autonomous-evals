import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function adaptBaseline(stage){
 const path=join(stage,'apps/web/src/server/sandbox/pipeline.test.ts');let s=readFileSync(path,'utf8');const original=s;const changes=[];
 const edit=(name,before,after)=>{if(s.split(before).length!==2)throw Error('Expected exactly one fixture match: '+name);s=s.replace(before,after);changes.push(name);};
 edit('SQL checkpoint fixture imports','import { beforeEach, describe, expect, it, vi } from "vitest";',`import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { ScenarioExecutionRecord } from './pipeline';
let checkpointSql: PGlite;
let checkpointDb: AgentTransactionalSql;
beforeAll(async () => {
 checkpointSql = new PGlite();
 await checkpointSql.exec(readFileSync(new URL('../../../../../packages/core/src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
 checkpointDb = { query:(q,p)=>checkpointSql.query(q,p), transaction:fn=>checkpointSql.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)})) };
});
afterAll(async () => { await checkpointSql.close(); });`);
 edit('Provide explicit test-only trusted ports','return { store: m.store, gateway: gw, runtime: () => rt, transport: () => transport, concurrency: 1, ...over };',`return { store: m.store, gateway: gw, runtime: () => rt, transport: () => transport, concurrency: 1,
 scenarioDispatch: { checkpoints:new PostgresTextCheckpointStore(checkpointDb), authorize:async()=>true, currentSecrets:async()=>[], validateResult:value=>value as ScenarioExecutionRecord }, ...over };`);
 edit('Reset SQL fences per independent original fixture','beforeEach(() => {\n  vi.mocked(generateScenarios)',`beforeEach(async () => {
  await checkpointSql.exec('TRUNCATE text_integration.checkpoints');
  vi.mocked(generateScenarios)`);
 edit('Budget fixture binds its existing world','budgetMicroUsd: 1_000, costMicroUsd: 1_000 });','budgetMicroUsd: 1_000, costMicroUsd: 1_000, worldId: "world_x" });');
 edit('Missing scenario is unresolved, not safe to tear down',`it("a scenario that is not part of the run is fatal", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    await expect(runScenarioTrials(deps, run.id, "sx_other", "w")).rejects.toBeInstanceOf(SandboxFatalError);
  });`,`it("a scenario outside the frozen run remains unresolved without dispatch", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1, worldId: "w" });
    expect(await runScenarioTrials(deps, run.id, "sx_other", "w")).toEqual({status:"unresolved",reason:"scenario_dispatch_identity"});
    expect(transport.posts).toBe(0);
  });`);
 edit('Lost result publication retains world for fenced replay',`it("a mid-run failure marks the run failed (retryable) and still tears down the world", async () => {
    const run = await seedRun({ k: 1 });
    vi.spyOn(m.store, "putRunResult").mockRejectedValueOnce(new Error("db blip"));
    await runRunInline(deps, run.id);
    const r = getRun(run.id);
    expect(r).toMatchObject({ status: "failed", errorKind: "retryable" });
    expect(r.error).toContain("db blip");
    expect(rt.prepared).toHaveLength(1);
    expect(rt.tornDown).toEqual(rt.prepared);
    expect(r.worldId).toBeNull();
  });`,`it("a lost result write remains unresolved and retains the world for replay", async () => {
    const run = await seedRun({ k: 1 });
    vi.spyOn(m.store, "putRunResult").mockRejectedValueOnce(new Error("db blip"));
    expect(await runRunInline(deps, run.id)).toEqual({runId:run.id,status:"unresolved"});
    const r = getRun(run.id);
    expect(r).toMatchObject({ status: "running", errorKind: null });
    expect(r.error).toBeNull();
    expect(rt.prepared).toHaveLength(1);
    expect(rt.tornDown).toEqual([]);
    expect(r.worldId).toBe(rt.prepared[0]);
  });`);
 edit('Compare complete version values independent of JSON object key order',
  'expect(res!.trials.every((t) => JSON.stringify(t.versions) === JSON.stringify(stored.versions))).toBe(true);',
  'for (const trial of res!.trials) expect(trial.versions).toEqual(stored.versions);');
 edit('Supply required empty cost metadata in original fixture',
  'await d.ctx.recordCost({ source: "ai_gateway", microUsd: 250 });',
  'await d.ctx.recordCost({ source: "ai_gateway", microUsd: 250, meta: {} });');
 // Original runtime tests are excluded from app tsc. Preserve their assertions while narrowing
 // known-present mock request arguments for this separate strict test compilation.
 if(s.split('req.categories').length!==4)throw Error('Unexpected request fixture count');
 s=s.replaceAll('req.categories','req!.categories');changes.push('Narrow three known-present mock request arguments');
 edit('Narrow the recorded mock request argument','c[2].categories![0]','c[2]!.categories![0]');
 writeFileSync(path,s);return {path:'apps/web/src/server/sandbox/pipeline.test.ts',beforeSha256:createHash('sha256').update(original).digest('hex'),afterSha256:createHash('sha256').update(s).digest('hex'),changes};
}
