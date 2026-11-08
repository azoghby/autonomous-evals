import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

test.describe("run compare", () => {
  test("requires sign-in and preserves the comparison in next=", async ({ page }) => {
    await page.goto("/sandbox/compare?base=sample&other=sample");
    await expect(page).toHaveURL(/\/signin\?next=%2Fsandbox%2Fcompare/);
  });

  test("compares two runs side by side with filterable scenario rows", async ({ page, request }) => {
    test.setTimeout(120_000);
    await signIn(page, request, "e2e-compare");

    // A new account has no runs of its own: the empty state explains what is needed.
    await page.goto("/sandbox/compare");
    await expect(page.getByRole("heading", { level: 1, name: "Did the change help?" })).toBeVisible();
    await expect(page.getByText(/You need two finished runs to compare/)).toBeVisible();
    await expect(page.getByRole("form", { name: "Choose runs to compare" })).toBeVisible();

    // The sample report is available to every signed-in user; comparing it with itself must show zero change.
    await page.getByRole("link", { name: "open the sample" }).click();
    await expect(page).toHaveURL(/base=sample&other=sample/);
    const metrics = page.getByRole("region", { name: "Headline deltas" });
    await expect(metrics.getByText("pass^k reliability")).toBeVisible();
    await expect(metrics.getByText("±0").first()).toBeVisible();

    const rows = page.getByRole("list", { name: "Scenario changes" }).getByRole("listitem");
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first()).toContainText("Unchanged");

    // Expand a row.
    await rows.first().locator("summary").click();
    await expect(rows.first().getByText(/No check failed here/)).toBeVisible();

    // URL-driven filter: no regressions when comparing a run with itself.
    await page.getByRole("navigation", { name: "Filter scenarios" }).getByRole("link", { name: /Regressions/ }).click();
    await expect(page).toHaveURL(/view=regressions/);
    await expect(page.getByText("No scenario got worse.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Regressions/ })).toHaveAttribute("aria-current", "page");
  });

  test("unknown run ids 404 instead of leaking existence", async ({ page, request }) => {
    test.setTimeout(90_000);
    await signIn(page, request, "e2e-compare404");
    const res = await page.goto("/sandbox/compare?base=sample&other=run_00000000-0000-0000-0000-000000000000");
    expect(res?.status()).toBe(404);
  });

  test("has no horizontal overflow at 375px", async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, request, "e2e-compare375");
    await page.goto("/sandbox/compare?base=sample&other=sample");
    await expect(page.getByRole("region", { name: "Headline deltas" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
