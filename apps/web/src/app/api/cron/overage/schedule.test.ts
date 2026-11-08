import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../vercel.json", import.meta.url)), "utf8")) as {
  crons: { path: string; schedule: string }[];
};

describe("overage cron schedule", () => {
  it("retries hourly on the 1st so a retry lands inside Stripe's 24h idempotency window", () => {
    const schedules = vercel.crons.filter((c) => c.path.startsWith("/api/cron/overage")).map((c) => c.schedule);
    expect(schedules).toContain("0 * 1 * *");
    expect(schedules).toContain("0 7 2-5 * *");
  });
});
