import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("landing page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Agents build your evals");
});

test("/start is reachable (or redirects to sign-in)", async ({ page }) => {
  const res = await page.goto("/start");
  expect(res?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/(start|signin)/);
});

test.describe("happy path", () => {
  test.skip(process.env.E2E_HAPPY_PATH !== "1", "set E2E_HAPPY_PATH=1 to run");

  test("trace audit reaches a quote", async ({ page, request }) => {
    test.setTimeout(90_000);
    const email = `e2e+${Date.now()}@example.com`;
    const fixture = readFileSync(join(__dirname, "fixtures", "trace-unsupported-claim.json"), "utf8");

    const linkRes = await request.post("/api/auth/request-link", { data: { email }, headers: { "x-forwarded-for": `192.0.2.${1 + Math.floor(Math.random() * 253)}` } });
    expect(linkRes.ok()).toBe(true);
    const { devLink } = (await linkRes.json()) as { devLink?: string };
    expect(devLink, "request-link must return devLink outside production").toBeTruthy();
    const token = new URL(devLink as string, "http://localhost").searchParams.get("token");
    await page.goto(`/signin/confirm?token=${token}`);
    await page.getByRole("button", { name: /continue to autonomous evals/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));

    await page.goto("/start");
    await expect(page).toHaveURL(/\/start/);

    await page.getByRole("radio", { name: /trace audit/i }).click();
    await page.getByRole("textbox", { name: /transcript or tool log/i }).fill(fixture);
    await page.getByRole("checkbox", { name: /authorized to test/i }).check();
    await page.getByRole("button", { name: /submit request/i }).click();

    await expect(page).toHaveURL(/\/jobs?\//, { timeout: 30_000 });
    await expect(page.getByText(/quote · version/i).first()).toBeVisible({ timeout: 120_000 });
    // Stripe checkout is out of scope for the automated run: stop at the quote card.
    await expect(page.getByText(/\$5(\.00)?/).first()).toBeVisible();
  });
});
