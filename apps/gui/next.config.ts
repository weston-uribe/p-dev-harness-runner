import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const operatorDistDir = process.env.P_DEV_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  // Operator launches set P_DEV_DIST_DIR to an isolated snapshot/staging path.
  // Developer `next dev` leaves this unset and uses the default `.next`.
  ...(operatorDistDir ? { distDir: operatorDistDir } : {}),
  serverExternalPackages: ["@cursor/sdk", "@linear/sdk", "@sentry/node"],
  // GitHub Codespaces / forwarded dev URLs use *.app.github.dev as the browser Host.
  allowedDevOrigins: ["*.app.github.dev"],
  experimental: {
    externalDir: true,
    serverActions: {
      allowedOrigins: ["localhost:3000", "*.app.github.dev"],
    },
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@harness": path.join(repoRoot, "src"),
    };
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        "diagnostics_channel",
      ];
    }
    return config;
  },
};

export default nextConfig;
