import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentCustomer = vi.fn();
const selectJob = vi.fn();
const insertValues = vi.fn(async () => undefined);
const sendJobEvent = vi.fn(async () => undefined);
const addMessage = vi.fn(async () => "m1");

vi.mock("@/server/queries", () => ({ getCurrentCustomer: () => getCurrentCustomer() }));
vi.mock("@/server/job-store", () => ({ addMessage: (...a: unknown[]) => addMessage(...a) }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: (...a: unknown[]) => sendJobEvent(...a) }));
vi.mock("@/server/http", async () => {
  const { z } = await import("zod");
  return {
    jsonError: (status: number, error: string, extra?: object) => Response.json({ error, ...extra }, { status }),
    isUuid: (s: string) => z.uuid().safeParse(s).success,
    readJson: async (req: Request, schema: any) => {
      const parsed = schema.safeParse(await req.json());
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, res: Response.json({ error: "bad" }, { status: 400 }) };
    },
  };
});
vi.mock("@ae/core/db/client", () => ({
  schema: { jobs: {}, interventions: {} },
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectJob() }) }) }),
    insert: () => ({ values: insertValues }),
  }),
}));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

import { POST } from "./route";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const call = (body: object = {}) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ jobId: JOB_ID }) });
const owner = { id: "u1", email: "o@x.io", isOperator: false };

describe("POST /api/jobs/[jobId]/cancel", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("401 when signed out", async () => {
    getCurrentCustomer.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
  it("404 for another customer's job", async () => {
    getCurrentCustomer.mockResolvedValue({ ...owner, id: "u2" });
    selectJob.mockReturnValue([{ customerId: "u1", state: "quoted" }]);
    expect((await call()).status).toBe(404);
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
  it("owner cancels while quoted", async () => {
    getCurrentCustomer.mockResolvedValue(owner);
    selectJob.mockReturnValue([{ customerId: "u1", state: "quoted" }]);
    const res = await call({ reason: "changed my mind" });
    expect(res.status).toBe(202);
    expect(sendJobEvent).toHaveBeenCalledWith(JOB_ID, { type: "cancel", reason: "changed my mind" });
    expect(addMessage).toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
  it("owner gets 409 once running", async () => {
    getCurrentCustomer.mockResolvedValue(owner);
    selectJob.mockReturnValue([{ customerId: "u1", state: "running" }]);
    expect((await call()).status).toBe(409);
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
  it("operator cancels a running job and records an intervention", async () => {
    getCurrentCustomer.mockResolvedValue({ id: "op", email: "op@x.io", isOperator: true });
    selectJob.mockReturnValue([{ customerId: "u1", state: "running" }]);
    expect((await call()).status).toBe(202);
    expect(insertValues).toHaveBeenCalledOnce();
    expect(sendJobEvent).toHaveBeenCalled();
  });
  it("409 for terminal jobs even for operators", async () => {
    getCurrentCustomer.mockResolvedValue({ id: "op", email: "op@x.io", isOperator: true });
    selectJob.mockReturnValue([{ customerId: "u1", state: "delivered" }]);
    expect((await call()).status).toBe(409);
  });
});
