import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    react()
  ],
  test: {
    browser: {
      provider: playwright(),
      enabled: true,
      headless: true,
      // force viewport size to landscape mode for the VideoPreview tests, otherwise @eatsjobs/media-mock
      // switches width and height on us with unhelpful results. At the moment the whole project makes no
      // sense on mobile anyway, so limiting tests this way should be fine.
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
      ]
    },
    mockReset: true,
    environment: "jsdom",
    include: [ "__tests__/**/*.test.{ts,tsx}" ],
    setupFiles: [ "__tests__/setup.ts" ],
    globals: true,
    server: {
      deps: {
        inline: [/@react-spectrum\/.*/, /@spectrum-icons\/.*/, /@adobe\/.*/]
      }
    }
  }
});
