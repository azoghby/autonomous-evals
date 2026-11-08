import { expect, test } from "@playwright/test";

test("/status renders the public headline and component levels only", async ({ page }) => {
  const res = await page.goto("/status");
  expect(res?.ok()).toBe(true);
  await expect(page).toHaveTitle(/Status · Standard Evals/);
  await expect(page.getByTestId("status-headline")).toHaveText(/operational|degraded|outage/i);
  await expect(page.locator("li.st-row", { hasText: "Website & API" })).toContainText(/operational|degraded|outage/i);
  await expect(page.getByText("/api/cron/")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /deployment/i })).toHaveCount(0);
});

test("/status has no horizontal overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/status");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("/api/status returns only the public summary, briefly cached", async ({ request }) => {
  const res = await request.get("/api/status");
  expect([200, 503]).toContain(res.status());
  expect(res.headers()["cache-control"]).toContain("s-maxage=");
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["components", "generatedAt", "overall"]);
  expect(Object.keys(body.overall).sort()).toEqual(["label", "level"]);
  expect(["operational", "degraded", "down"]).toContain(body.overall.level);
  for (const c of body.components) expect(Object.keys(c).sort()).toEqual(["id", "label", "level"]);
});

test("/api/status?detail=1 requires an operator", async ({ request }) => {
  const res = await request.get("/api/status?detail=1");
  expect(res.status()).toBe(401);
});
