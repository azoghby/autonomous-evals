import { expect, test } from "@playwright/test";

/**
 * /feedback form. The success path mocks POST /api/feedback (so the run never writes feedback rows); the
 * validation / honeypot checks hit the real route, which rejects before any DB write.
 */
test.describe("feedback form", () => {
  test("submits answers with the ref token and shows the thank-you state", async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/feedback", async (route) => {
      posted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/feedback?ref=e2e_Token-123");
    await expect(page.getByRole("heading", { level: 1, name: "Would you actually use this?" })).toBeVisible();

    await page.getByLabel("Maybe").check();
    await page.getByLabel("What would make it a must-have for you?").fill("A GitHub Action that fails the PR on regressions.");
    await page.getByLabel("What would you pay per month?").fill("$49");
    await page.getByLabel("A sentence we may quote publicly (optional)").fill("Grading on database state is the right idea.");
    await page.getByLabel(/may show this quote on its website/).check();
    await page.getByLabel("Name (optional)").fill("E2E Tester");
    await page.getByRole("button", { name: /Send feedback/ }).click();

    await expect(page.getByRole("status")).toContainText("Thank you");
    expect(posted).toMatchObject({
      ref: "e2e_Token-123", wouldUse: "maybe", pricePerMonth: "$49", quoteConsent: true, name: "E2E Tester",
      quote: "Grading on database state is the right idea.",
    });
  });

  test("shows a field error when the server rejects the answer", async ({ page }) => {
    await page.route("**/api/feedback", (route) => route.fulfill({
      status: 400, contentType: "application/json",
      body: JSON.stringify({ error: "Please check the highlighted fields.", fieldErrors: { wouldUse: ["Required"] } }),
    }));
    await page.goto("/feedback");
    await page.getByRole("button", { name: /Send feedback/ }).click();
    await expect(page.getByText("Pick yes, maybe or no.")).toBeVisible();
    await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
  });

  test("the real API rejects invalid input and swallows honeypot posts", async ({ request }) => {
    const bad = await request.post("/api/feedback", { data: { wouldUse: "definitely" } });
    expect(bad.status()).toBe(400);
    expect(await bad.json()).toMatchObject({ fieldErrors: { wouldUse: expect.any(Array) } });
    const bot = await request.post("/api/feedback", { data: { wouldUse: "yes", website: "http://spam.example" } });
    expect(bot.status()).toBe(200);
  });
});
