import type { MetadataRoute } from "next";

const SITE_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** Signed-in, token-bearing or operator routes (there is no /dashboard). */
const PRIVATE_PATHS = [
  "/api/", "/r/", "/jobs", "/evals", "/operator", "/settings", "/signin", "/oauth/", "/notify/",
  "/expert/r/", "/expert/book", "/expert/opt-out", "/sandbox/runs/", "/sandbox/compare",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE_PATHS }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
