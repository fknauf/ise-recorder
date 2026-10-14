import type { NextConfig } from "next";
import { glob } from "glob";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  reactCompiler: {
    panicThreshold: "all_errors"
  },
  transpilePackages: [
    "@adobe/react-spectrum",
    "@react-spectrum/*",
    "@spectrum-icons/*"
  ].flatMap(spec => glob.sync(`${spec}`, { cwd: "node_modules/" })),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Permissions-Policy",
            value: "camera=self, microphone=self, display-capture=self, autoplay=self, payment=(), geolocation=(), clipboard-read=(), clipboard-write=()"
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff"
          },
          {
            key: "Referrer-Policy",
            value: "same-origin"
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin"
          }
        ]
      }
    ];
  },
  experimental: {
    optimizePackageImports: [
      "@mantine/core",
      "@mantine/hooks",
      "@mantine/modals",
      "@mantine/notifications",
      "@mantine/store"
    ],
  }
};

export default nextConfig;
