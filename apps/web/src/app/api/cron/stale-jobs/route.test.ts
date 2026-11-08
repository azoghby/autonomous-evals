import { describe, expect, it, vi } from "vitest";

const inserted = vi.hoisted(() => [] as Array<{ table: string; values: Record<string, unknown> }>);

vi.mock("../_auth", () => ({ requireCronAuth: () => null }));
vi.mock("../../../../server/stale-jobs", () => ({ processStaleJobs: async () => ({ errors: [] }) }));
vi.mock("./recovery", () => ({ loadCandidates: async () => [], staleJobDeps: {} }));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const schema = { payments: { id: "id", jobId: "job_id", createdAt: "created_at", status: "status" }, progressEvents: { name: "progress_events", id: "id", jobId: "job_id", milestone: "m" }, interventions: { name: "interventions" } };
  let call = 0;
  return {
    schema,
    db: () => ({
      select: () => ({ from: () => ({ where: () => {
        call++;
        const rows = call === 1 ? [{ id: "p1", jobId: "j1", createdAt: new Date(Date.now() - 6 * 86_400_000) }] : [];
        return Object.assign(Promise.resolve(rows), { limit: async () => [] });
      } }) }),
      insert: (t: { name: string }) => ({ values: async (values: Record<string, unknown>) => { inserted.push({ table: t.name, values }); } }),
    }),
  };
});

import { GET } from "./route";

describe("GET /api/cron/stale-jobs: expiring authorizations", () => {
  it("keeps operator-only wording out of the customer-visible progress event", async () => {
    const res = await GET(new Request("http://x/api/cron/stale-jobs"));
    expect((await res.json()).expiringAuthorizations).toEqual(["j1"]);
    const progress = inserted.find((i) => i.table === "progress_events")!.values.message as string;
    expect(progress).not.toMatch(/internal|operator|expire/i);
    expect(inserted.find((i) => i.table === "interventions")!.values.note).toMatch(/Capture or release/);
  });
});
