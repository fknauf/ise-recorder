import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { listenForFileDownload } from "./__tests__/command-download";

export default defineConfig({
  resolve: {
    tsconfigPaths: true
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
