import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";

/** The shortcut listener attaches on hydration; the trigger flags it. */
const hydrated = (page: Page) => expect(page.locator('.cp-trigger[data-ready="true"]')).toBeAttached({ timeout: 30_000 });

test.describe("command palette", () => {
  test("opens with the keyboard shortcut, filters, and navigates", async ({ page }) => {
    await page.goto("/sandbox");
    await hydrated(page);
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeHidden();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();

    await input.fill("leader");
    const first = dialog.getByRole("option").first();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(first).toContainText("Leaderboard");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leaderboard$/, { timeout: 30_000 });
    await expect(dialog).toBeHidden();
  });

  test("arrow keys move the selection and Escape closes, restoring focus", async ({ page }) => {
    await page.goto("/sandbox");
    await hydrated(page);
    const trigger = page.getByRole("button", { name: "Open command palette" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    const options = dialog.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");

    await dialog.getByRole("combobox").fill("qqqxxj");
    await expect(dialog.getByText(/No matches/)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("signed-out visitors get a sign-in hint instead of recent evals", async ({ page }) => {
    await page.goto("/sandbox");
    await hydrated(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("status").filter({ hasText: /Sign in to jump/ })).toBeVisible();
  });

  test("signed-in users see their recent evals from the database", async ({ page, request }) => {
    test.setTimeout(90_000);
    await signIn(page, request, "e2e-palette");
    await page.goto("/evals");
    await hydrated(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    // A brand-new account has no evals: the palette must not invent any.
    await expect(dialog.getByRole("status")).toHaveText(/\d+ results?/, { timeout: 45_000 });
    await expect(dialog.getByText("Recent evals")).toHaveCount(0);
    await dialog.getByRole("combobox").fill("compare");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sandbox\/compare/);
  });

  test("fits a 375px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/sandbox");
    await hydrated(page);
    await page.getByRole("button", { name: "Open command palette" }).click();
    const box = await page.getByRole("dialog", { name: "Command palette" }).boundingBox();
    expect(box?.width ?? 999).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
