/** Fail-closed resource creation, shared by the operator-only Naïve provisioner. */
import { createHash } from "node:crypto";

export type ProvisionResourceKind = "skill" | "outcome" | "agent" | "vault" | "credential" | "deployment";
export interface ProvisionReceipt { id: string; version?: number }
export interface ProvisionIntent {
  key: string;
  fingerprint: string;
  state: "pending" | "complete";
  receipt?: ProvisionReceipt;
}
export interface ProvisionJournal {
  read(key: string): Promise<ProvisionIntent | undefined>;
  /** Must atomically insert-if-absent, durably, before returning. */
  claim(intent: ProvisionIntent): Promise<{ inserted: boolean; intent: ProvisionIntent }>;
  complete(key: string, fingerprint: string, receipt: ProvisionReceipt): Promise<void>;
}
export interface ProvisionOperation {
  kind: ProvisionResourceKind;
  /** Stable, operator-controlled identifier. Never a credential value. */
  name: string;
  /** SHA-256 of canonical desired config, including a credential hash (never plaintext). */
  fingerprint: string;
  /** Complete, bounded discovery; reject duplicate matches and pagination uncertainty. */
  discover(): Promise<ProvisionReceipt | undefined>;
  /** Exact identity/config verification; must reject an active deployment. */
  attest(receipt: ProvisionReceipt): Promise<void>;
  /** SDK client must use the supplied key for this operation only. Deployments use enabled:false. */
  create(idempotencyKey: string): Promise<ProvisionReceipt>;
}
export class NaiveProvisionError extends Error {
  constructor(readonly code: "invalid_plan" | "inspection_failed" | "configuration_drift" | "creation_uncertain" | "journal_failed") {
    super(`Naive provisioning blocked: ${code}`);
    this.name = "NaiveProvisionError";
  }
}
const validReceipt = (r: ProvisionReceipt): boolean => /^[a-z]+_[a-zA-Z0-9]+$/.test(r.id) &&
  (r.version === undefined || (Number.isSafeInteger(r.version) && r.version > 0));

/** No provider errors/configuration/secrets escape this boundary. No retries of ambiguous creates. */
export async function provisionResources(
  operations: readonly ProvisionOperation[], journal: ProvisionJournal, options: { dryRun?: boolean } = {},
): Promise<Array<{ kind: ProvisionResourceKind; name: string; status: "existing" | "missing" | "created"; receipt?: ProvisionReceipt }>> {
  const keys = new Set<string>();
  for (const op of operations) {
    const key = `${op.kind}:${op.name}`;
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(op.name) || !/^[a-f0-9]{64}$/.test(op.fingerprint) || keys.has(key)) {
      throw new NaiveProvisionError("invalid_plan");
    }
    keys.add(key);
  }
  // Inspect the entire plan before the first mutation, including dry runs.
  const found: Array<ProvisionReceipt | undefined> = [];
  for (const op of operations) {
    let receipt: ProvisionReceipt | undefined;
    try { receipt = await op.discover(); } catch { throw new NaiveProvisionError("inspection_failed"); }
    if (receipt) {
      try { if (!validReceipt(receipt)) throw new Error(); await op.attest(receipt); }
      catch { throw new NaiveProvisionError("configuration_drift"); }
    }
    let prior: ProvisionIntent | undefined;
    try { prior = await journal.read(`naive-provision:${op.kind}:${op.name}`); } catch { throw new NaiveProvisionError("journal_failed"); }
    if (prior && (prior.fingerprint !== op.fingerprint || (receipt && prior.receipt && (receipt.id !== prior.receipt.id || receipt.version !== prior.receipt.version)))) throw new NaiveProvisionError("configuration_drift");
    found.push(receipt);
  }
  const result: Array<{ kind: ProvisionResourceKind; name: string; status: "existing" | "missing" | "created"; receipt?: ProvisionReceipt }> = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    const existing = found[i];
    if (existing || options.dryRun) {
      result.push({ kind: op.kind, name: op.name, status: existing ? "existing" : "missing", ...(existing ? { receipt: existing } : {}) });
      continue;
    }
    const key = `naive-provision:${op.kind}:${op.name}`;
    let claimed: Awaited<ReturnType<ProvisionJournal["claim"]>>;
    try { claimed = await journal.claim({ key, fingerprint: op.fingerprint, state: "pending" }); }
    catch { throw new NaiveProvisionError("journal_failed"); }
    if (claimed.intent.fingerprint !== op.fingerprint) throw new NaiveProvisionError("configuration_drift");
    // A pending claim may represent a successful request whose response was lost.
    // Discovery found nothing: never infer that a retry is safe, even with an idempotency key.
    if (!claimed.inserted) throw new NaiveProvisionError("creation_uncertain");
    let receipt: ProvisionReceipt;
    try {
      const idempotencyKey = createHash("sha256").update(`${key}:${op.fingerprint}`).digest("hex");
      receipt = await op.create(idempotencyKey);
      if (!validReceipt(receipt)) throw new Error();
      await op.attest(receipt);
    } catch { throw new NaiveProvisionError("creation_uncertain"); }
    try { await journal.complete(key, op.fingerprint, receipt); }
    catch { throw new NaiveProvisionError("journal_failed"); }
    result.push({ kind: op.kind, name: op.name, status: "created", receipt });
  }
  return result;
}

import type { AgentCreate, DeploymentCreate, VettaClient } from "@usenaive-sdk/managed-agents";
import { attestAgentConfiguration, type ExpectedAgentConfiguration } from "./provision";
export type ProvisionClientFactory = (key?: string) => Pick<VettaClient, "agents" | "deployments">;
export function configFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
async function listAll<T extends {id:string}>(list:(q:{limit:number;after?:string})=>Promise<{data:T[];has_more:boolean;next_cursor:string|null}>):Promise<T[]> {
  const result:T[]=[]; const cursors=new Set<string>(); const ids=new Set<string>(); let after:string|undefined;
  for(let i=0;i<20;i++) { const page=await list({limit:100,after});
    if(page.data.length>100 || typeof page.has_more!=="boolean" || (page.has_more ? !page.next_cursor : page.next_cursor!==null)) throw Error();
    for(const item of page.data){if(ids.has(item.id))throw Error();ids.add(item.id);result.push(item);}
    if(!page.has_more)return result;
    if(cursors.has(page.next_cursor!))throw Error();cursors.add(page.next_cursor!);after=page.next_cursor!;
  } throw Error();
}
export function buildAgentOperation(client:ProvisionClientFactory, desired:AgentCreate & ExpectedAgentConfiguration, pin?:ProvisionReceipt):ProvisionOperation {
  desired=structuredClone(desired);
  pin=pin ? structuredClone(pin) : undefined;
  if(!desired.name.startsWith("ae-") || desired.metadata.ae_managed!==true)throw new NaiveProvisionError("invalid_plan");
  return {kind:"agent",name:desired.name,fingerprint:configFingerprint(desired),
    async discover(){const matches=(await listAll(q=>client().agents.list(q))).filter(a=>a.name===desired.name);if(matches.length>1)throw Error();const a=matches[0];if(pin && (!a || a.id!==pin.id))throw Error();return a ? {id:a.id,version:pin?.version ?? a.current_version}:undefined;},
    async attest(r){if(!r.version || (pin && (r.id!==pin.id || r.version!==pin.version)))throw Error();const a=await client().agents.get(r.id);if(a.id!==r.id || a.name!==desired.name)throw Error();const config=await client().agents.getVersion(r.id,r.version);if(config.version!==r.version)throw Error();attestAgentConfiguration(config,desired);},
    async create(key){const a=await client(key).agents.create(desired);return {id:a.id,version:a.current_version};}};
}
export function buildPausedDeploymentOperation(client:ProvisionClientFactory,name:string,desired:DeploymentCreate):ProvisionOperation {
  desired=structuredClone(desired);
  if(desired.enabled!==false || !desired.agent_version || desired.budget_micro_usd<=0)throw new NaiveProvisionError("invalid_plan");
  const fields=["agent_id","agent_version","cron","timezone","input_template","budget_micro_usd","window","on_idle","identity","enabled"] as const;
  // Explicit values avoid attesting unknown provider defaults.
  const expected={timezone:"UTC",window:"immediate",on_idle:null,identity:null,...desired,enabled:false};
  return {kind:"deployment",name,fingerprint:configFingerprint(expected),
    async discover(){const matches=(await listAll(q=>client().deployments.list(q))).filter(d=>d.agent_id===desired.agent_id);if(matches.length>1)throw Error();return matches[0]?{id:matches[0].id}:undefined;},
    async attest(r){const d=await client().deployments.get(r.id);if(d.id!==r.id || d.enabled!==false || d.schedule_status!=="paused" || d.next_run_at!==null || fields.some(f=>d[f]!==expected[f]))throw Error();},
    async create(key){const d=await client(key).deployments.create(expected as DeploymentCreate);if(d.enabled!==false || d.schedule_status!=="paused" || d.next_run_at!==null)throw Error();return {id:d.id};}};
}
