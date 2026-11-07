import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";

/**
 * Browser half of the pipeline proof. Needs a dev server with mock services, AUTH_DEV_LINKS=1 and
 * DEV_SIMULATE_PAYMENTS=1, and OPERATOR_EMAILS exported to this process (first entry is used to simulate payment).
 *   E2E_PIPELINE=1 E2E_BASE_URL=http://localhost:3100 OPERATOR_EMAILS=... npx playwright test e2e/pipeline.spec.ts
 */
test.describe("pipeline", () => {
  test.skip(process.env.E2E_PIPELINE !== "1", "set E2E_PIPELINE=1 to run");

  test("fixture trace audit is delivered with findings and validated fixes", async ({ page, context, baseURL }) => {
    test.setTimeout(240_000);
    const base = baseURL ?? "http://localhost:3100";
    const operatorEmail = (process.env.OPERATOR_EMAILS ?? "").split(",")[0]?.trim();
    expect(operatorEmail, "OPERATOR_EMAILS must be set").toBeTruthy();
    const fakeIp = `192.0.2.${1 + Math.floor(Math.random() * 253)}`; // avoid per-IP rate limits across runs
    const headers = { "x-forwarded-for": fakeIp };

    // Customer signs in through the real UI: dev link -> confirm page -> click.
    const link = await context.request.post("/api/auth/request-link", { data: { email: `e2e-pipeline-ui+${Date.now()}@example.com` }, headers });
    const { devLink } = (await link.json()) as { devLink?: string };
    expect(devLink).toBeTruthy();
    const token = new URL(devLink as string, base).searchParams.get("token");
    await page.goto(`/signin/confirm?token=${token}`);
    await page.getByRole("button", { name: /continue to autonomous evals/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));

    // Warm the Next dev compiler for every page/API the flow touches BEFORE a workflow is in flight: an on-demand
    // compile of the workflow bundle while a job runs can drop its in-memory queue message in the local World.
    await page.goto("/start");
    await page.goto("/jobs/00000000-0000-4000-8000-000000000000");
    await context.request.get("/api/jobs");
    await context.request.get("/api/jobs/00000000-0000-4000-8000-000000000000/progress");
    await context.request.get("/api/jobs/00000000-0000-4000-8000-000000000000/artifacts/report");

    // Create the job (cookies are shared with the page context).
    const trace = readFileSync(join(__dirname, "fixtures", "trace-unsupported-claim.json"), "utf8");
    const created = await context.request.post("/api/jobs", {
      data: { package: "trace_audit", trace, authorizedToTest: true },
      headers: { ...headers, "idempotency-key": `pw-pipeline-${Date.now()}` },
    });
    expect(created.status()).toBe(201);
    const { jobId } = (await created.json()) as { jobId: string };

    // NOTE: the job page only live-polls planning/running/investigating (job-view.tsx POLLING_STATES), so a page opened
    // while the job is draft/quoted/awaiting_payment never updates. Wait on the API, then load the page.
    const stateOf = async () => (await (await context.request.get(`/api/jobs/${jobId}/progress`)).json()).state as string;
    await expect.poll(stateOf, { timeout: 120_000 }).toBe("quoted");
    await page.goto(`/jobs/${jobId}`);
    await expect(page.getByText(/\$5(\.00)?/).first()).toBeVisible({ timeout: 20_000 });

    // Operator simulates the payment (no Stripe key locally).
    const op = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: headers });
    const opLink = await op.post("/api/auth/request-link", { data: { email: operatorEmail } });
    const opToken = new URL(((await opLink.json()) as { devLink: string }).devLink, base).searchParams.get("token");
    expect((await op.post("/api/auth/verify", { data: { token: opToken } })).ok()).toBe(true);
    const sim = await op.post("/api/dev/simulate-payment", { data: { jobId } });
    expect(sim.status()).toBe(200);

    // Delivered, as shown in the UI.
    await expect.poll(stateOf, { timeout: 120_000 }).toBe("delivered");
    await page.reload();
    await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Unsupported success claim/i).first()).toBeVisible();
    await expect(page.getByText(/1 of 1 fixes verified/i)).toBeVisible();
    // The finding card is collapsed by default; the validated fix lives inside it.
    await page.getByRole("button", { name: /Unsupported success claim/i }).click();
    await expect(page.getByText(/Fix · /i).first()).toBeVisible();
    await expect(page.getByText(/^verified$/i).first()).toBeVisible();

    // The downloadable report carries the "Validated fixes" section.
    const report = await context.request.get(`/api/jobs/${jobId}/artifacts/report`);
    expect(report.status()).toBe(200);
    expect(await report.text()).toContain("## Validated fixes");
    await op.dispose();
  });
});
