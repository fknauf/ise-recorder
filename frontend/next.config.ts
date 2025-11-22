import type { NextConfig } from "next";
import { glob } from 'glob';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  transpilePackages: [
    '@adobe/react-spectrum',
    '@react-spectrum/*',
    '@spectrum-icons/*'
  ].flatMap((spec) => glob.sync(`${spec}`, { cwd: 'node_modules/' })),
  output: "standalone",
  async headers() {
    return [
      {
        source: '/',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'camera=self, microphone=self, display-capture=self, autoplay=self, payment=(), geolocation=(), clipboard-read=(), clipboard-write=()'
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'Referrer-Policy',
            value: 'same-origin'
          },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests;"
          }
        ]
      }
    ]
  }
};

module.exports = nextConfig

export default nextConfig;
