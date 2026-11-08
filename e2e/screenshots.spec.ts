import { test } from "@playwright/test";
import { signIn } from "./helpers/auth";

// Manual capture helper, skipped unless SHOT_DIR is set:
//   SHOT_DIR=/abs/path E2E_BASE_URL=... npx playwright test e2e/screenshots.spec.ts
const DIR = process.env.SHOT_DIR ?? "";
test.skip(!DIR, "set SHOT_DIR to capture screenshots");

test("capture feature screenshots", async ({ page, request }) => {
  test.setTimeout(240_000);
  await signIn(page, request, "e2e-shots");
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });

    await page.goto("/sandbox/compare?base=sample&other=sample");
    await page.locator(".rc-row summary").first().click();
    await page.screenshot({ path: `${DIR}/compare-${width}.png`, fullPage: true });

    await page.goto("/status");
    await page.waitForSelector("h1");
    await page.screenshot({ path: `${DIR}/status-${width}.png`, fullPage: true });

    await page.goto("/evals");
    await page.locator('.cp-trigger[data-ready="true"]').waitFor({ state: "attached" });
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("status").filter({ hasText: /result/ }).waitFor();
    await page.screenshot({ path: `${DIR}/palette-${width}.png` });
    await page.getByRole("combobox").fill("comp");
    await page.screenshot({ path: `${DIR}/palette-search-${width}.png` });
    await page.keyboard.press("Escape");
  }
});
