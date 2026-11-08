import { describe, expect, it } from "vitest";
import { provisionResources, type ProvisionIntent, type ProvisionJournal, type ProvisionOperation } from "./naive-provisioning";
const fingerprint = "a".repeat(64);
function fixture() {
  const rows = new Map<string, ProvisionIntent>();
  const calls: string[] = [];
  const journal: ProvisionJournal = {
    async read(key) { return rows.get(key); },
    async claim(intent) { const prior = rows.get(intent.key); if (prior) return { inserted:false,intent:prior }; rows.set(intent.key,intent); return {inserted:true,intent}; },
    async complete(key,fp,receipt) { rows.set(key,{key,fingerprint:fp,state:"complete",receipt}); },
  };
  const op: ProvisionOperation = {kind:"agent",name:"ae-test",fingerprint,
    async discover(){calls.push("discover");return undefined;}, async attest(){calls.push("attest");},
    async create(key){calls.push(key);return {id:"agt_test",version:1};}};
  return {op,journal,rows,calls};
}
describe("provision resource safety",()=>{
  it("dry run never claims or creates",async()=>{const f=fixture();expect(await provisionResources([f.op],f.journal,{dryRun:true})).toEqual([{kind:"agent",name:"ae-test",status:"missing"}]);expect(f.rows.size).toBe(0);expect(f.calls).toEqual(["discover"]);});
  it("attests all existing resources before any create",async()=>{const f=fixture();const bad={...f.op,name:"ae-bad",discover:async()=>({id:"agt_bad"}),attest:async()=>{throw Error("secret");}};await expect(provisionResources([f.op,bad],f.journal)).rejects.toThrow("configuration_drift");expect(f.rows.size).toBe(0);});
  it("persists intent before create and completes receipt",async()=>{const f=fixture();f.op.create=async key=>{expect(f.rows.size).toBe(1);expect(key).toMatch(/^[a-f0-9]{64}$/);return {id:"agt_test",version:1};};await provisionResources([f.op],f.journal);expect([...f.rows.values()][0]?.state).toBe("complete");});
  it("never repeats an ambiguous create and redacts provider error",async()=>{const f=fixture();let count=0;f.op.create=async()=>{count++;throw Error("secret value");};await expect(provisionResources([f.op],f.journal)).rejects.toThrow("creation_uncertain");await expect(provisionResources([f.op],f.journal)).rejects.toThrow("creation_uncertain");expect(count).toBe(1);});
  it("recovers an ambiguous create through attested discovery",async()=>{const f=fixture();f.op.create=async()=>{throw Error();};await expect(provisionResources([f.op],f.journal)).rejects.toThrow();f.op.discover=async()=>({id:"agt_test",version:1});expect((await provisionResources([f.op],f.journal))[0]?.status).toBe("existing");});
  it("rejects changed fingerprints on a pending operation",async()=>{const f=fixture();f.op.create=async()=>{throw Error();};await expect(provisionResources([f.op],f.journal)).rejects.toThrow();f.op.fingerprint="b".repeat(64);await expect(provisionResources([f.op],f.journal)).rejects.toThrow("configuration_drift");});
  it("rejects duplicate operations before discovery",async()=>{const f=fixture();await expect(provisionResources([f.op,f.op],f.journal)).rejects.toThrow("invalid_plan");expect(f.calls).toEqual([]);});
});

import { buildAgentOperation, buildPausedDeploymentOperation, type ProvisionClientFactory } from "./naive-provisioning";
import { buildAgentCreateBody } from "./provision";
describe("SDK provisioning boundaries",()=>{
  it("detaches agent config before fingerprint and create",async()=>{
    const desired=buildAgentCreateBody('commercial');let captured:unknown;
    const factory=(()=>({agents:{create:async(body:unknown)=>{captured=body;return {id:'agt_test',current_version:1};}}})) as unknown as ProvisionClientFactory;
    const op=buildAgentOperation(factory,desired);desired.system='mutated';await op.create('stable-key');expect((captured as {system:string}).system).not.toBe('mutated');
  });
  it("requires deployment creation to be paused with a positive budget and version",()=>{
    const factory=(()=>({})) as unknown as ProvisionClientFactory;
    expect(()=>buildPausedDeploymentOperation(factory,'ae-test',{agent_id:'agt_test',cron:'* * * * *',input_template:'x',budget_micro_usd:0,enabled:false,agent_version:1})).toThrow('invalid_plan');
    expect(()=>buildPausedDeploymentOperation(factory,'ae-test',{agent_id:'agt_test',cron:'* * * * *',input_template:'x',budget_micro_usd:300000,enabled:true,agent_version:1})).toThrow('invalid_plan');
  });
  it("rejects provider activation at creation without calling pause",async()=>{
    const factory=(()=>({deployments:{create:async()=>({id:'dep_test',enabled:true,schedule_status:'scheduled',next_run_at:'soon'})}})) as unknown as ProvisionClientFactory;
    const op=buildPausedDeploymentOperation(factory,'ae-test',{agent_id:'agt_test',cron:'* * * * *',input_template:'x',budget_micro_usd:300000,enabled:false,agent_version:1});await expect(op.create('key')).rejects.toThrow();
  });
  it("preflights later journal drift before creating earlier resources",async()=>{
    const f=fixture();const later={...f.op,name:'ae-later'};f.rows.set('naive-provision:agent:ae-later',{key:'naive-provision:agent:ae-later',fingerprint:'b'.repeat(64),state:'pending'});
    await expect(provisionResources([f.op,later],f.journal)).rejects.toThrow('configuration_drift');expect(f.calls).toEqual(['discover','discover']);
  });
});
