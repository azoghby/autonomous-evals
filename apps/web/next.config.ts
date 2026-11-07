import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ae/core"],
  serverExternalPackages: ["stripe"],
};

export default withWorkflow(nextConfig);
