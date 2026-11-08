import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJobCancellation, markJobCancellationDelivered, listPendingCancellationJobs, markJobCancellationAttempt, markJobCancellationCheckoutDone, type CancellationPool } from "./job-cancellation";

function fixture(options: { state?: string; owner?: string; email?: string; retained?: boolean; failMessage?: boolean; failCommit?: boolean; failRollback?: boolean } = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const row = { job_id: "job", reason: "original", requested_by: "owner", as_operator: false, event_delivered_at: null };
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql === "COMMIT" && options.failCommit) throw new Error("commit uncertain");
    if (sql === "ROLLBACK" && options.failRollback) throw new Error("rollback failed");
    if (sql.includes("SELECT customer_id")) return { rows: [{ customer_id: options.owner ?? "owner", state: options.state ?? "draft" }] };
    if (sql.includes("SELECT email")) return { rows: [{ email: options.email ?? "owner@example.com" }] };
    if (sql.includes("SELECT *")) return { rows: options.retained ? [row] : [] };
    if (sql.includes("INSERT INTO workflow_stage.cancellations")) return { rows: [{ ...row, reason: params![1], requested_by: params![2], as_operator: params![3] }] };
    if (options.failMessage && sql.includes("INSERT INTO messages")) throw new Error("message failed");
    return { rows: [] };
  });
  const pool: CancellationPool = { connect: async () => ({ query, release }) };
  return { pool, calls, release };
}
afterEach(() => vi.unstubAllEnvs());
describe("durable cancellation authority", () => {
  it("locks the canonical job and writes intent and message before committing", async () => {
    const f = fixture();
    const result = await requestJobCancellation("job", { id: "owner" }, " stop ", f.pool);
    expect(result).toMatchObject({ ok: true, created: true, request: { reason: "stop" } });
    expect(f.calls.map(c => c.sql).join("\n")).toMatch(/BEGIN[\s\S]*jobs WHERE id=\$1 FOR UPDATE[\s\S]*customers[\s\S]*INSERT INTO workflow_stage.cancellations[\s\S]*INSERT INTO messages[\s\S]*COMMIT/);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("retains the original receipt on terminal retries without another message", async () => {
    const f = fixture({ state: "cancelled", retained: true });
    expect(await requestJobCancellation("job", { id: "owner" }, "replacement", f.pool)).toMatchObject({ ok: true, created: false, request: { reason: "original" } });
    expect(f.calls.some(c => c.sql.includes("INSERT"))).toBe(false);
  });
  it("does not reveal retained intent to a currently unauthorized viewer", async () => {
    const f = fixture({ retained: true });
    expect(await requestJobCancellation("job", { id: "outsider" }, "x", f.pool)).toMatchObject({ ok: false, status: 404 });
    expect(f.calls.some(c => c.sql.includes("SELECT *"))).toBe(false);
  });
  it("rejects an owner after planning before creating any intent", async () => {
    const f = fixture({ state: "running" });
    expect(await requestJobCancellation("job", { id: "owner" }, "x", f.pool)).toMatchObject({ ok: false, status: 409 });
    expect(f.calls.some(c => c.sql.includes("INSERT"))).toBe(false);
  });
  it("uses the current operator email and records the intervention atomically", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
    const f = fixture({ state: "running", email: "operator@example.com" });
    expect(await requestJobCancellation("job", { id: "operator" }, "halt", f.pool)).toMatchObject({ ok: true, request: { asOperator: true } });
    expect(f.calls.find(c => c.sql.includes("INSERT INTO interventions"))?.params).toEqual(["job", "operator@example.com", "Cancelled job: halt"]);
  });
  it("does not grant an operator role to an owner-scoped MCP identity", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
    const f = fixture({ state: "running", email: "operator@example.com" });
    expect(await requestJobCancellation("job", { id: "operator", allowOperator: false }, "halt", f.pool)).toMatchObject({ ok: false, status: 404 });
    expect(f.calls.some(c => c.sql.includes("INSERT"))).toBe(false);
  });
  it("rolls back intent if the audit message fails", async () => {
    const f = fixture({ failMessage: true });
    await expect(requestJobCancellation("job", { id: "owner" }, "x", f.pool)).rejects.toThrow("message failed");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.calls.some(c => c.sql === "COMMIT")).toBe(false);
  });
  it("discards an uncertain commit connection and never retries the writes", async () => {
    const f = fixture({ failCommit: true });
    await expect(requestJobCancellation("job", { id: "owner" }, "x", f.pool)).rejects.toThrow("commit uncertain");
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({ message: "commit uncertain" }));
    expect(f.calls.filter(c => c.sql.includes("INSERT INTO messages"))).toHaveLength(1);
  });
  it("preserves the original error when rollback fails and discards the connection", async () => {
    const f = fixture({ failMessage: true, failRollback: true });
    await expect(requestJobCancellation("job", { id: "owner" }, "x", f.pool)).rejects.toThrow("message failed");
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({ message: "rollback failed" }));
  });
  it("bounds a non-finite pending limit before passing SQL parameters", async () => {
    const f = fixture();
    await listPendingCancellationJobs(Number.NaN, f.pool);
    expect(f.calls[0]?.params).toEqual([100]);
  });
  it("acknowledges delivery without replacing payload or creating intent", async () => {
    const f = fixture();
    await markJobCancellationDelivered("job", f.pool);
    expect(f.calls).toEqual([{ sql: "UPDATE workflow_stage.cancellations SET event_delivered_at=COALESCE(event_delivered_at,now()) WHERE job_id=$1", params: ["job"] }]);
  });
});


it("rotates failed batches through all pending requests using actual SQL", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE SCHEMA workflow_stage;
      CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,state text NOT NULL DEFAULT 'awaiting_payment',updated_at timestamptz DEFAULT now());
      CREATE TABLE customers(id uuid PRIMARY KEY,email text);
      CREATE TABLE messages(job_id uuid,role text,body text);
      CREATE TABLE interventions(job_id uuid,operator_email text,kind text,note text);
      CREATE TABLE progress_events(job_id uuid,milestone text,message text);`);
    await pg.exec(readFileSync("docs/naive-cancellation-integration/sql/001-job-cancellation.sql", "utf8"));
    const owner = "22222222-2222-4222-8222-222222222222";
    await pg.query("INSERT INTO customers(id) VALUES($1)", [owner]);
    const ids = Array.from({length: 61}, (_, n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`);
    for (const id of ids) {
      await pg.query("INSERT INTO jobs(id) VALUES($1)", [id]);
      await pg.query("INSERT INTO workflow_stage.cancellations(job_id,reason,requested_by,as_operator) VALUES($1,'missing hook',$2,false)", [id, owner]);
    }
    const pool: CancellationPool = { connect: async () => ({ query: async (sql, params) => {
      const result = await pg.query<Record<string, unknown>>(sql, params);
      return { rows: result.rows };
    }, release: () => {} }) };
    // A newly admitted request becomes terminal before the event or checkout provider is contacted.
    const fresh = "11111111-1111-4111-8111-999999999999";
    await pg.query("UPDATE customers SET email='owner@example.com' WHERE id=$1", [owner]);
    await pg.query("INSERT INTO jobs(id,customer_id) VALUES($1,$2)", [fresh,owner]);
    expect(await requestJobCancellation(fresh, { id: owner }, "stop now", pool)).toMatchObject({ok:true,created:true});
    expect((await pg.query<{state:string}>("SELECT state FROM jobs WHERE id=$1", [fresh])).rows[0]!.state).toBe("cancelled");
    expect(await requestJobCancellation(fresh, { id: owner }, "replacement", pool)).toMatchObject({ok:true,created:false,request:{reason:"stop now"}});
    expect((await pg.query<{count:number}>("SELECT count(*)::int AS count FROM progress_events WHERE job_id=$1 AND milestone='cancelled'", [fresh])).rows[0]!.count).toBe(1);
    await markJobCancellationDelivered(fresh, pool);
    await markJobCancellationCheckoutDone(fresh, pool);
    const attempted = new Set<string>();
    for (let round = 0; round < 3; round++) {
      for (const id of await listPendingCancellationJobs(25, pool)) {
        attempted.add(id);
        await markJobCancellationAttempt(id, pool);
        // A permanently missing hook leaves both acknowledgements pending.
      }
    }
    expect(attempted.size).toBe(61);
    expect((await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM workflow_stage.cancellations WHERE event_delivered_at IS NULL AND checkout_done_at IS NULL")).rows[0]!.count).toBe(61);
  } finally { await pg.close(); }
});
