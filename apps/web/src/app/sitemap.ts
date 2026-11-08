import type { MetadataRoute } from "next";

const SITE_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const ROUTES = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/sample", priority: 0.8, changeFrequency: "monthly" },
  { path: "/leaderboard", priority: 0.8, changeFrequency: "daily" },
  { path: "/start", priority: 0.8, changeFrequency: "monthly" },
  { path: "/experts", priority: 0.5, changeFrequency: "monthly" },
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((r) => ({ url: `${SITE_URL}${r.path}`, lastModified, changeFrequency: r.changeFrequency, priority: r.priority }));
}
