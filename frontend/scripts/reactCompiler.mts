import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ReactCompilerOptions, TransformOptions } from "oxc-transform-react";

/**
 * Shared React Compiler configuration.
 *
 * vitest.config.mts applies this transform to the suite; __tests__/build audits which
 * functions it actually compiles. Both import from here so the audit cannot drift away
 * from the transform it is auditing and start reporting on a configuration nothing uses.
 *
 * next build runs the Rust port of the compiler inside Turbopack
 * (experimental.turbopackRustReactCompiler), which has no JS API. oxc-transform-react is
 * oxc's build of the same Rust port, so it is the closest stand-in available outside a
 * build -- and the same implementation oxlint's react compiler rules run. It is not the
 * very same binary as next's, so the two can in principle disagree on an edge case.
 */

/** Only src/ is compiled, mirroring next build: test files are not part of the bundle. */
export const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

/** Whether the React Compiler is meant to look at this file at all. */
export function isCompilableSource(file: string): boolean {
  return file.startsWith(SOURCE_ROOT) && /\.tsx?$/.test(file);
}

/** Major version of the React that is actually installed, as next reads it. */
const REACT_MAJOR = (
  createRequire(import.meta.url)("react/package.json") as { version: string }
).version.split(".")[0];

/**
 * Mirrors what next hands its Rust compiler for a production client build, anonymous
 * functions left unnamed. panicThreshold stays "none": the audit wants every diagnostic
 * reported, not the transform aborted at the first one. (next's Rust compiler does not
 * act on panicThreshold at all -- a bail builds green either way.)
 *
 * The target follows next's own detection: set only for React 18, otherwise left to the
 * compiler's default, which is the newest React the compiler release knows. A React
 * upgrade needs no change here -- only compiler releases that know the new version.
 */
export const REACT_COMPILER: ReactCompilerOptions = {
  ...(REACT_MAJOR === "18" ? { target: "18" } : {}),
  panicThreshold: "none",
  environment: { enableNameAnonymousFunctions: false },
};

/** The transform around the compiler: TypeScript stripped, everything else left to vite. */
export function reactCompilerOptions(file: string): TransformOptions {
  return {
    // must not be tsx for .ts: that makes `<Type>value` assertions, which
    // browserStorage.ts uses, parse as an unclosed JSX element
    lang: file.endsWith(".tsx") ? "tsx" : "ts",
    sourceType: "module",
    // only the compiler runs here; JSX and the remaining transforms are left to vite
    jsx: "preserve",
    reactCompiler: REACT_COMPILER,
  };
}
