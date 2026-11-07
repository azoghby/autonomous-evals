import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ae/core"],
  serverExternalPackages: ["stripe"],
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

export default withWorkflow(nextConfig);
