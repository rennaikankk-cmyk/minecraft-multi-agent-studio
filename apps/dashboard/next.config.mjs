/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: [
    "@minecraft-studio/environment",
    "@minecraft-studio/observability",
    "@minecraft-studio/protocol",
  ],
};

export default nextConfig;
