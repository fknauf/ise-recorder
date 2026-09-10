import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { listenForFileDownload } from "./__tests__/command-download.mjs";

export default defineConfig({
  resolve: {
    tsconfigPaths: true
  },
  // Pre-bundle these at startup. They enter the browser module graph only through
  // __tests__/util/serverEnv.test.ts, so Vite would otherwise discover them mid-run,
  // re-optimize, and reload the page underneath whatever is executing -- which fails
  // every test in the file with a bogus "doesn't provide an export named 'default'".
  optimizeDeps: {
    include: [ "next/server", "validator/es/lib/isURL" ]
  },
  plugins: [ react() ],
  test: {
    browser: {
      provider: playwright(),
      enabled: true,
      headless: true,
      ui: false,
      instances: [
        {
          browser: "chromium",
          viewport: {
            width: 1920,
            height: 1080
          }
        },
        {
          browser: "firefox",
          viewport: {
            width: 1920,
            height: 1080
          }
        }
      ],
      commands: {
        listenForFileDownload
      }
    },
    mockReset: true,
    environment: "jsdom",
    include: [ "__tests__/**/*.test.{ts,tsx}" ],
    setupFiles: [ "__tests__/setup.ts" ],
    globals: true,
    server: {
      deps: {
        inline: [
          /@react-spectrum\/.*/,
          /@spectrum-icons\/.*/,
          /@adobe\/.*/
        ]
      }
    }
  }
});
