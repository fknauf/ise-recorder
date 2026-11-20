import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { transformSync } from "oxc-transform-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { listenForFileDownload } from "./__tests__/command-download.mjs";
import { isCompilableSource, reactCompilerOptions } from "./scripts/reactCompiler.mjs";

/**
 * Run the React Compiler over src/ the way `next build` does.
 *
 * next.config.ts sets reactCompiler: true, so what ships is compiled and leans on the
 * compiler for memoisation. Without this the suite runs un-compiled React and disagrees
 * with the build about which callbacks keep their identity across a render -- which is
 * how a redundant useCallback in AudioPreview came to look load-bearing.
 *
 * next runs the Rust port of the compiler; this runs oxc's build of that port (see
 * scripts/reactCompiler.mts). Not babel: the babel plugin is a different implementation
 * and disagrees with the Rust port -- it bails on optional chaining inside try/catch,
 * which the Rust port compiles.
 *
 * @vitejs/plugin-react's `compiler: true` would run the same package, but a plugin of our
 * own shares its options with the audit in __tests__/build, so the two cannot drift apart.
 *
 * enforce: "pre" so this sees the original source, before vite's own transform -- the
 * compiler needs the JSX intact. It strips the types itself and leaves JSX for vite.
 */
function reactCompiler(): Plugin {
  return {
    name: "react-compiler",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];

      if (!isCompilableSource(file)) {
        return null;
      }

      const result = transformSync(file, code, {
        ...reactCompilerOptions(file),
        sourcemap: true,
      });

      if (result.fatal) {
        throw new Error(
          `React Compiler failed on ${file}:\n${result.errors.map((e) => e.codeframe ?? e.message).join("\n")}`,
        );
      }

      return { code: result.code, map: result.map };
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // see the stub for why this is safe
      "server-only": fileURLToPath(new URL("./__tests__/stubs/server-only.ts", import.meta.url)),
    },
  },
  optimizeDeps: {
    // react/compiler-runtime needs to be pulled in manually because vitest scans the code
    // for deps before it's compiled, when it doesn't depend on react/compiler-runtime yet.
    include: [
      "next/server",
      "validator/es/lib/isURL",
      "validator/es/lib/isInt",
      "react/compiler-runtime",
      "react-dom/server",
    ],
  },
  plugins: [reactCompiler(), react()],
  test: {
    projects: [
      {
        // The application suite, in real browsers. Each instance is a project of its own
        // and names itself: without that, vitest derives the name from this project's --
        // "browser (chromium)", or "0 (chromium)" when it is unnamed. CI runs the browsers
        // in separate steps and filters on these names.
        extends: true,
        test: {
          browser: {
            provider: playwright(),
            enabled: true,
            headless: true,
            ui: false,
            instances: [
              {
                name: "chromium",
                browser: "chromium",
                viewport: {
                  width: 1920,
                  height: 1080,
                },
              },
              {
                name: "firefox",
                browser: "firefox",
                viewport: {
                  width: 1920,
                  height: 1080,
                },
              },
            ],
            commands: {
              listenForFileDownload,
            },
          },
          mockReset: true,
          include: ["__tests__/**/*.test.{ts,tsx}"],
          exclude: ["__tests__/build/**"],
          setupFiles: ["__tests__/setup.ts"],
          globals: true,
        },
      },
      {
        // checks about the build itself, which need node: a filesystem and the native
        // compiler binding. No plugins inherited, so the sources are read as text rather
        // than transformed.
        test: {
          name: "build",
          environment: "node",
          include: ["__tests__/build/**/*.test.ts"],
          globals: true,
        },
      },
    ],
  },
});
