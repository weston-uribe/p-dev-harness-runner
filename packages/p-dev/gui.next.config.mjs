/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@cursor/sdk", "@linear/sdk"],
  allowedDevOrigins: ["*.app.github.dev"],
  experimental: {
    externalDir: true,
    serverActions: {
      allowedOrigins: ["localhost:3000", "*.app.github.dev"],
    },
  },
};

export default nextConfig;
