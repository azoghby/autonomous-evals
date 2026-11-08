import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentCustomer = vi.fn();
const getJobForViewer = vi.fn();
const addMessage = vi.fn(async () => "m1");
const sendJobEvent = vi.fn(async () => undefined);
const insertValues = vi.fn(async () => undefined);

vi.mock("@/server/queries", () => ({
  getCurrentCustomer: () => getCurrentCustomer(),
  getJobForViewer: (...a: unknown[]) => getJobForViewer(...a),
}));
vi.mock("@/server/job-store", () => ({ addMessage: (...a: unknown[]) => addMessage(...a) }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: (...a: unknown[]) => sendJobEvent(...a) }));
vi.mock("@ae/core/db/client", () => ({ schema: { interventions: {} }, db: () => ({ insert: () => ({ values: insertValues }) }) }));
vi.mock("@/server/http", () => ({
  jsonError: (status: number, error: string, extra?: object) => Response.json({ error, ...extra }, { status }),
  readJson: async (req: Request, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
    const p = schema.safeParse(await req.json());
    return p.success ? { ok: true, data: p.data } : { ok: false, res: Response.json({}, { status: 400 }) };
  },
}));

import { POST } from "./route";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const call = (body: object) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ jobId: JOB_ID }) });
const owner = { id: "u1", email: "o@x.io", isOperator: false };
const operator = { id: "op", email: "op@x.io", isOperator: true };

describe("POST /api/jobs/[jobId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJobForViewer.mockResolvedValue({ job: { customerId: "u1", state: "needs_clarification" } });
  });

  it("owner answer is stored as customer and notifies the workflow", async () => {
    getCurrentCustomer.mockResolvedValue(owner);
    const res = await call({ answer: "yes" });
    expect(res.status).toBe(201);
    expect(addMessage).toHaveBeenCalledWith(JOB_ID, "customer", "yes");
    expect(sendJobEvent).toHaveBeenCalledWith(JOB_ID, { type: "clarification_answer", answer: "yes" });
    expect(insertValues).not.toHaveBeenCalled();
  });
  it("operator answer is stored as operator and does NOT trigger the event", async () => {
    getCurrentCustomer.mockResolvedValue(operator);
    const res = await call({ answer: "note" });
    expect(res.status).toBe(201);
    expect(addMessage).toHaveBeenCalledWith(JOB_ID, "operator", "note");
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
  it("operator with asCustomer:true triggers the event and records an intervention", async () => {
    getCurrentCustomer.mockResolvedValue(operator);
    await call({ answer: "on their behalf", asCustomer: true });
    expect(addMessage).toHaveBeenCalledWith(JOB_ID, "customer", "on their behalf");
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB_ID, operatorEmail: "op@x.io" }));
    expect(sendJobEvent).toHaveBeenCalled();
  });
  it("a non-operator cannot use asCustomer to impersonate", async () => {
    getCurrentCustomer.mockResolvedValue({ ...owner, id: "u2" });
    getJobForViewer.mockResolvedValue({ job: { customerId: "u1", state: "needs_clarification" } });
    await call({ answer: "x", asCustomer: true });
    expect(addMessage).toHaveBeenCalledWith(JOB_ID, "operator", "x");
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
});
