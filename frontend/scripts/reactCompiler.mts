import { fileURLToPath } from "node:url";
import type { TransformOptions } from "@babel/core";

/**
 * Shared React Compiler configuration.
 *
 * vitest.config.mts applies this transform to the suite; __tests__/build audits which
 * functions it actually compiles. Both import from here so the audit cannot drift away
 * from the transform it is auditing and start reporting on a configuration nothing uses.
 */

/** Only src/ is compiled, mirroring next build: test files are not part of the bundle. */
export const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

/** Whether the React Compiler is meant to look at this file at all. */
export function isCompilableSource(file: string): boolean {
  return file.startsWith(SOURCE_ROOT) && (/\.tsx?$/).test(file);
}

/**
 * What next passes for a production client build, read out of
 * next/dist/build/get-babel-loader-config.js. No target: that is only set for React 18.
 * Currently identical to passing {}, but pinning it means a change in the plugin's
 * defaults cannot quietly split the test and build pipelines apart.
 */
export function reactCompilerOptions(file: string): TransformOptions {
  return {
    filename: file,
    configFile: false,
    babelrc: false,
    // the jsx plugin must stay off for .ts: it makes `<Type>value` assertions, which
    // browserStorage.ts uses, parse as an unclosed JSX element
    parserOpts: {
      plugins: file.endsWith(".tsx") ? [ "jsx", "typescript" ] : [ "typescript" ]
    },
    plugins: [
      [
        "babel-plugin-react-compiler",
        { environment: { enableNameAnonymousFunctions: false } }
      ]
    ]
  };
}
