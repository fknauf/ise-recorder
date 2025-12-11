import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    react()
  ],
  test: {
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
