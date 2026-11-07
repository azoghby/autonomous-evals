import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileEvaluationDataStore } from "./persistence";
import { acquireEvaluationData, type EvaluationDataTask } from "./acquisition";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eval-data-")); roots.push(root);
  const store = createFileEvaluationDataStore(root);
  const task = await acquireEvaluationData({taskId:"task", jobId:"job",targetId:"target",description:"calendar constraints",requirements:[{id:"conflict",description:"booking conflicts",minimumCases:1}],factualAnswersRequired:true}, {cases:[],sources:[]}, {
    store, discover:async()=>({status:"pending"}), generate:async()=>({status:"pending"}), expert:async()=>({status:"pending"}),
  });
  return {root, store, task};
}
describe("durable evaluation-data store", () => {
  it("survives restart and preserves first-write decisions and CAS", async () => {
    const {root,store,task} = await fixture();
    const restarted = createFileEvaluationDataStore(root);
    expect(await restarted.get("task")).toEqual(task);
    expect((await restarted.insertIfAbsent({...task, revision:0})).inserted).toBe(false);
    const next = {...task, revision:task.revision+1, state:"waiting_for_expert" as const};
    expect(await restarted.compareAndSet("task",task.revision,next)).toEqual(next);
    expect(await store.compareAndSet("task",task.revision,next)).toBeNull();
    expect((await store.get("task"))?.decisions).toEqual(task.decisions);
  });
  it("rejects corruption and secrets without overwriting the last safe record", async () => {
    const {root,store,task} = await fixture();
    await expect(store.compareAndSet("task",task.revision,{...task,revision:task.revision+1,spec:{...task.spec,description:"password=supersecret"}})).rejects.toThrow();
    expect(await store.get("task")).toEqual(task);
    const file = (await readdir(root)).find((name)=>name.endsWith(".json"))!;
    const body = JSON.parse(await readFile(join(root,file),"utf8"));
    body.payload = body.payload.replace("calendar", "modified");
    await writeFile(join(root,file),JSON.stringify(body));
    await expect(store.get("task")).rejects.toThrow("storage read failed");
  });
  it("allows one concurrent CAS winner and preserves scoped identities", async () => {
    const {root,store,task} = await fixture();
    const other = createFileEvaluationDataStore(root);
    const results = await Promise.allSettled([store,other].map((port)=>port.compareAndSet("task",task.revision,{...task,revision:task.revision+1})));
    expect(results.filter((r)=>r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    expect((await store.get("task"))?.revision).toBe(task.revision+1);
    expect(await store.get("../task")).toBeNull();
    await expect(store.compareAndSet("task",task.revision+1,{...task,taskId:"other", revision:task.revision+2} as EvaluationDataTask)).rejects.toThrow();
  });
});
