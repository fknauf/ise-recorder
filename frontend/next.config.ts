import type { NextConfig } from "next";
import { glob } from "glob";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  reactCompiler: true,
  transpilePackages: [
    "@adobe/react-spectrum",
    "@react-spectrum/*",
    "@spectrum-icons/*"
  ].flatMap(spec => glob.sync(`${spec}`, { cwd: "node_modules/" })),
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Permissions-Policy",
            value: "camera=self, microphone=self, display-capture=self, autoplay=self, payment=(), geolocation=(), clipboard-read=(), clipboard-write=()"
          },
          {
            key: "X-Frame-Options",
            value: "DENY"
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff"
          },
          {
            key: "Referrer-Policy",
            value: "same-origin"
          }
        ]
      }
    ];
  }
};

module.exports = nextConfig;

export default nextConfig;
