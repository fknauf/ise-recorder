import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { transformAsync } from "@babel/core";
import { fileURLToPath } from "node:url";
import { isCompilableSource, reactCompilerOptions } from "./scripts/reactCompiler.mjs";
import { playwright } from "@vitest/browser-playwright";
import { listenForFileDownload } from "./__tests__/command-download.mjs";
import macros from "unplugin-parcel-macros";

/**
 * Run the React Compiler over src/ the way `next build` does.
 *
 * next.config.ts sets reactCompiler: true, so what ships is compiled and leans on the
 * compiler for memoisation. Without this the suite runs un-compiled React and disagrees
 * with the build about which callbacks keep their identity across a render -- which is
 * how a redundant useCallback in AudioPreview came to look load-bearing.
 *
 * @vitejs/plugin-react can do this via `compiler: true`, but that runs oxc's experimental
 * Rust port rather than the babel plugin Next uses. The two disagree: babel declines to
 * compile useMediaDevices and oxc compiles it. Running babel here keeps the test pipeline
 * and the build pipeline on the same implementation, and drops a dependency whose version
 * is pinned to plugin-react's by an optional peer range that npm only warns about.
 *
 * enforce: "pre" so this sees the original TypeScript, before esbuild strips the types --
 * the compiler needs the JSX intact. Types are left in place for esbuild to remove
 * afterwards; only the compiler transform runs here.
 */
function reactCompiler(): Plugin {
  return {
    name: "react-compiler",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];

      if(!isCompilableSource(file)) {
        return null;
      }

      const result = await transformAsync(code, {
        ...reactCompilerOptions(file),
        sourceMaps: true
      });

      return result?.code === undefined || result.code === null
        ? null
        : { code: result.code, map: result.map };
    }
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // see the stub for why this is safe
      "server-only": fileURLToPath(new URL("./__tests__/stubs/server-only.ts", import.meta.url))
    }
  },
  optimizeDeps: {
    // react/compiler-runtime needs to be pulled in manually because vitest scans the code
    // for deps before it's compiled, when it doesn't depend on react/compiler-runtime yet.
    include: [ "next/server", "validator/es/lib/isURL", "validator/es/lib/isInt", "react/compiler-runtime", "react-dom/server" ]
  },
  /**
   * macros must come first, and not only because next.config.ts runs it first too.
   *
   * `@react-spectrum/s2/style` publishes no browser export condition -- only node -- because the
   * style macro is meant to be evaluated at build time and never shipped. Without the plugin, vite
   * cannot resolve it at all and every S2 component fails to load.
   *
   * The order is then forced by the React Compiler: reactCompilerOptions() parses with the "jsx"
   * and "typescript" babel plugins but not "importAttributes", so babel cannot parse
   * `with {type: "macro"}`. Running macros first strips those imports back out, so babel never
   * sees the syntax it has no parser for. Swapping the two fails on every file that imports the
   * style macro.
   */
  plugins: [ macros.vite(), reactCompiler(), react() ],
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
                  height: 1080
                }
              },
              {
                name: "firefox",
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
          exclude: [ "__tests__/build/**" ],
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
      },
      {
        // checks about the build itself, which need node: a filesystem and babel. No
        // plugins inherited, so the sources are read as text rather than transformed.
        test: {
          name: "build",
          environment: "node",
          include: [ "__tests__/build/**/*.test.ts" ],
          globals: true
        }
      }
    ]
  }
});
