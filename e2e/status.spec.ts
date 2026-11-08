import { expect, test } from "@playwright/test";

test("/status renders the headline and a database row with ms latency", async ({ page }) => {
  const res = await page.goto("/status");
  expect(res?.ok()).toBe(true);
  await expect(page).toHaveTitle(/Status · Standard Evals/);
  await expect(page.getByTestId("status-headline")).toHaveText(/operational|degraded|outage/i);
  const dbRow = page.locator("li.st-row", { hasText: "Database" });
  await expect(dbRow).toContainText(/\d+(\.\d+)? ms/);
  await expect(page.getByRole("heading", { name: /scheduled jobs/i })).toBeVisible();
});

test("/status has no horizontal overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/status");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("/api/status returns the summary JSON, uncached", async ({ request }) => {
  const res = await request.get("/api/status");
  expect([200, 503]).toContain(res.status());
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = await res.json();
  for (const key of ["generatedAt", "overall", "app", "probes", "database", "jobs", "sandbox", "crons"]) expect(body).toHaveProperty(key);
  expect(["operational", "degraded", "down"]).toContain(body.overall.level);
  expect(Array.isArray(body.probes)).toBe(true);
  expect(typeof body.database?.latencyMs).toBe("number");
});
