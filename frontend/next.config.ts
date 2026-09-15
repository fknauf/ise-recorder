import type { NextConfig } from "next";
import macros from "unplugin-parcel-macros";

const plugin = macros.webpack();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  reactCompiler: true,
  webpack(config) {
    config.plugins.push(plugin);
    config.cache = false;

    // Bundle all S2 and style-macro generated CSS into a single bundle instead of code splitting.
    // Because atomic CSS has so much overlap between components, loading all CSS up front results in
    // smaller bundles instead of producing duplication between pages.
    config.optimization.splitChunks ||= {};
    config.optimization.splitChunks.cacheGroups ||= {};
    config.optimization.splitChunks.cacheGroups.s2 = {
      name: "s2-styles",
      test(module: { identifier: () => string; type: string }) {
        return (module.type === "css/mini-extract" && module.identifier().includes("@react-spectrum/s2")) || (/macro-(.*?)\.css/).test(module.identifier());
      },
      chunks: "all",
      enforce: true
    };

    return config;
  },
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
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups"
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp"
          },
          {
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin"
          }
        ]
      }
    ];
  }
};

export default nextConfig;
