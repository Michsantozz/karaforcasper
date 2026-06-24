import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // casper-js-sdk e libs de cripto rodam só no server; nunca empacotar no client bundle.
  serverExternalPackages: [
    "casper-js-sdk",
    "@mastra/core",
    "@mastra/memory",
    "@mastra/inngest",
    "inngest",
  ],
};

export default nextConfig;
