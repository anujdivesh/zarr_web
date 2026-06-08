import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/zarr-web',
  output: 'standalone',   // Required for Docker standalone mode
  assetPrefix: '/zarr-web',
  turbopack: {}, 
  // Add any other Next.js config options here, but no webpack section
};

export default nextConfig;