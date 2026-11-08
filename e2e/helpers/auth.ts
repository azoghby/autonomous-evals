import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Signs a fresh e2e customer in via the dev magic link (requires AUTH_DEV_LINKS / non-production).
 * Each call uses a random TEST-NET source IP to stay under the request-link rate limit.
 */
export async function signIn(page: Page, request: APIRequestContext, prefix = "e2e"): Promise<string> {
  const email = `${prefix}+${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const linkRes = await request.post("/api/auth/request-link", {
    data: { email },
    headers: { "x-forwarded-for": `192.0.2.${1 + Math.floor(Math.random() * 253)}` },
  });
  expect(linkRes.ok()).toBe(true);
  const { devLink } = (await linkRes.json()) as { devLink?: string };
  expect(devLink, "request-link must return devLink outside production").toBeTruthy();
  const token = new URL(devLink as string, "http://localhost").searchParams.get("token");
  await page.goto(`/signin/confirm?token=${token}`);
  await page.getByRole("button", { name: /continue to (standard|autonomous) evals/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  return email;
}
