import { describe, expect, it, vi } from "vitest";

const JOB_ID = "c7cf8113-df6b-4af1-9cde-b3545af7402e";
const job = { id: JOB_ID, customerId: "owner-1", package: "trace_audit", state: "running", error: null, intake: {}, reportBlobPath: null, traceBlobPath: null, idempotencyKey: "k", workflowRunId: null, neonBranchId: null };

vi.mock("server-only", () => ({}));
vi.mock("./session", () => ({ getCurrentCustomer: async () => null }));
vi.mock("./job-store", () => ({ getJob: async (id: string) => (id === JOB_ID ? job : null) }));
// Every select().from().where().orderBy() chain resolves to an empty row set.
vi.mock("@ae/core/db/client", async (orig) => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "orderBy", "limit", "innerJoin"]) chain[m] = () => chain;
  chain.then = (res: (v: unknown[]) => unknown) => res([]);
  return { ...(await orig<object>()), db: () => chain };
});

import { getJobForViewer } from "./queries";

describe("getJobForViewer", () => {
  it("lets an operator load a job owned by another customer (200 path, not null/throw)", async () => {
    const data = await getJobForViewer(JOB_ID, { id: "op-1", email: "op@x", isOperator: true });
    expect(data?.job.id).toBe(JOB_ID);
    expect(data?.quotes).toEqual([]);
  });
  it("hides a foreign job from a non-operator", async () => {
    expect(await getJobForViewer(JOB_ID, { id: "other", email: "o@x", isOperator: false })).toBeNull();
  });
});
