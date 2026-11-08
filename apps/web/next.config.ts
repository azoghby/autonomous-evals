import { withWorkflow } from "workflow/next";
import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@ae/core"],
  serverExternalPackages: ["stripe", "agentmail"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Tailwind v4 via the Turbopack loader (no postcss config in this repo).
  turbopack: {
    rules: {
      "*.css": {
        loaders: [{ loader: "@tailwindcss/turbopack", options: {} }],
        as: "*.css",
      },
    },
  },
};

export default withWorkflow(withBotId(nextConfig));
