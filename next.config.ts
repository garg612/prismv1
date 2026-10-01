import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents:true,
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
        port: '',
        pathname: '**',
      },
    ],
  },
  allowedDevOrigins: process.env.NEXT_PUBLIC_DEV_ORIGIN ? [new URL(process.env.NEXT_PUBLIC_DEV_ORIGIN).hostname] : [],
};

export default nextConfig;
