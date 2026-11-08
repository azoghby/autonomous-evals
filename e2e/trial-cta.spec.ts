import { expect, test } from "@playwright/test";

test("/pricing Pro CTA offers the 14-day free trial and signed-out checkout asks to sign in", async ({ page }) => {
  await page.goto("/pricing");
  const cta = page.getByRole("button", { name: "Start 14-day free trial" });
  await expect(cta).toBeVisible();
  await expect(page.getByText(/coming soon\. a self-serve/i)).toHaveCount(0);

  await cta.click();
  await page.waitForURL(/\/signin/);
  expect(page.url()).toContain("next=");
});

test("homepage pricing section links the Pro trial CTA to /pricing", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: "Start 14-day free trial" });
  await expect(cta).toHaveAttribute("href", "/pricing?checkout=pro");
});

test("cancel FAQ points to the live billing portal, not 'coming soon'", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByText(/Manage billing to cancel/)).toBeAttached();
});
