import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Clarification path. Needs mock services (the "[needs-clarification]" marker), AUTH_DEV_LINKS=1.
 *   E2E_PIPELINE=1 E2E_BASE_URL=http://localhost:3100 npx playwright test e2e/clarify.spec.ts
 */
test.describe("clarification", () => {
  test.skip(process.env.E2E_PIPELINE !== "1", "set E2E_PIPELINE=1 to run");

  test("marker job asks a question, answer leads to a quote", async ({ page, context, baseURL }) => {
    test.setTimeout(180_000);
    const base = baseURL ?? "http://localhost:3100";
    const headers = { "x-forwarded-for": `192.0.2.${1 + Math.floor(Math.random() * 253)}` };

    const link = await context.request.post("/api/auth/request-link", { data: { email: `e2e-clarify+${Date.now()}@example.com` }, headers });
    const { devLink } = (await link.json()) as { devLink?: string };
    expect(devLink).toBeTruthy();
    const token = new URL(devLink as string, base).searchParams.get("token");
    await page.goto(`/signin/confirm?token=${token}`);
    await page.getByRole("button", { name: /continue to autonomous evals/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));

    // Warm compilers before a workflow is in flight (see pipeline.spec.ts).
    await page.goto("/start");
    await page.goto("/jobs/00000000-0000-4000-8000-000000000000");
    await context.request.get("/api/jobs/00000000-0000-4000-8000-000000000000/progress");

    const trace = readFileSync(join(__dirname, "fixtures", "trace-unsupported-claim.json"), "utf8");
    const created = await context.request.post("/api/jobs", {
      data: { package: "trace_audit", trace, notes: "[needs-clarification]", authorizedToTest: true },
      headers: { ...headers, "idempotency-key": `pw-clarify-${Date.now()}` },
    });
    expect(created.status()).toBe(201);
    const { jobId } = (await created.json()) as { jobId: string };

    const stateOf = async () => (await (await context.request.get(`/api/jobs/${jobId}/progress`)).json()).state as string;
    await expect.poll(stateOf, { timeout: 60_000 }).toBe("needs_clarification");

    await page.goto(`/jobs/${jobId}`);
    await expect(page.getByRole("heading", { name: /need a bit more detail/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/What specific agent behavior/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("textbox", { name: /your answer/i }).fill("Focus on unsupported success claims.");
    await page.getByRole("button", { name: /send answer/i }).click();

    await expect.poll(stateOf, { timeout: 60_000 }).toBe("quoted");
    await page.goto(`/jobs/${jobId}`);
    await expect(page.getByText(/\$5(\.00)?/).first()).toBeVisible({ timeout: 20_000 });
  });
});
