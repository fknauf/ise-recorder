import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type OxcError, transformSync } from "oxc-transform-react";
import { expect, test } from "vitest";
import {
  isCompilableSource,
  REACT_COMPILER,
  reactCompilerOptions,
  SOURCE_ROOT,
} from "../../scripts/reactCompiler.mjs";

/**
 * Audits which functions the React Compiler actually compiles.
 *
 * next.config.ts sets reactCompiler: true and the code is written to lean on it -- no
 * hand-written useCallback or useMemo. When the compiler quietly declines a function,
 * nothing fails: the code stays correct and simply stops being memoised, so the loss
 * shows up as a performance regression nobody can trace. This turns that silence into a
 * failing test naming the function and the reason.
 *
 * The build does not do this job: next's Rust compiler ignores panicThreshold, so a
 * function it declines builds green even in CI. The oxlint react rules report the same
 * diagnostics, but only for the rules the lint config switches on.
 *
 * It runs in the "build" project, which is node rather than browser: it needs a
 * filesystem and the native compiler binding, and it reads the sources as text rather
 * than importing them.
 */

interface Bail {
  file: string;
  line: number | undefined;
  reason: string;
}

/**
 * Functions the compiler currently refuses, with the reason it gives. These are known
 * gaps, not approvals -- an entry here means that code is un-memoised in production.
 * Delete an entry once the code is reworked; the test below fails on stale entries, so
 * the list cannot quietly outlive the problem.
 */
const KNOWN_BAILS: Record<string, string> = {};

/** A function body opting out of the compiler. The compiler skips these without a word. */
const OPT_OUT_DIRECTIVE = /^\s*["']use no (?:memo|forget)["']/gm;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      sourceFiles(path, found);
    } else if (isCompilableSource(path)) {
      found.push(path);
    }
  }

  return found;
}

/** Run the compiler with every recoverable diagnostic -- bail-outs included -- reported. */
function compile(path: string, source: string) {
  return transformSync(path, source, {
    ...reactCompilerOptions(path),
    reactCompiler: { ...REACT_COMPILER, reportDiagnostics: true },
  });
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/**
 * The codeframe carries the position as `,-[file:line:col]` and the compiler's error
 * category as `react-compiler(Category)`. A diagnostic without a category is not from the
 * compiler at all -- a parse error, which next build would fail on too.
 */
function toBail(file: string, error: OxcError): Bail {
  const frame = error.codeframe ?? "";
  const line = /:(\d+):\d+\]/.exec(frame)?.[1];
  const category = /react-compiler\((\w+)\)/.exec(frame)?.[1] ?? "Parse";

  return {
    file,
    line: line === undefined ? undefined : Number(line),
    reason: `${category}: ${error.message}`,
  };
}

/** Compile every source file, recording which files it compiled and what it refused. */
function auditSourceTree(): { compiled: string[]; bails: Bail[] } {
  const compiled: string[] = [];
  const bails: Bail[] = [];

  for (const path of sourceFiles(SOURCE_ROOT)) {
    const file = relative(SOURCE_ROOT, path);
    const source = readFileSync(path, "utf8");
    const result = compile(path, source);

    // the compiler's runtime is imported once per file that has at least one memoised
    // function; files of plain helpers legitimately go without
    if (result.code.includes("react/compiler-runtime")) {
      compiled.push(file);
    }

    bails.push(...result.errors.map((error) => toBail(file, error)));

    for (const match of source.matchAll(OPT_OUT_DIRECTIVE)) {
      bails.push({
        file,
        line: lineOf(source, match.index),
        reason: `OptOut: ${match[0].trim()} directive`,
      });
    }
  }

  return { compiled, bails };
}

const { compiled, bails } = auditSourceTree();

const describeBail = (bail: Bail) => `${bail.file}:${bail.line ?? "?"} -- ${bail.reason}`;

test("the audit actually ran the compiler", () => {
  // guards against the audit silently passing because it compiled nothing at all, which
  // would make every other assertion here vacuous
  expect(compiled.length).toBeGreaterThan(10);
});

test("the audit sees bail-outs when there are some", () => {
  // the other half of the guard above: with diagnostics no longer reported -- an option
  // renamed, a default flipped -- "nothing refused" would pass on a broken audit too
  const path = join(SOURCE_ROOT, "__audit_canary__.tsx");
  const result = compile(
    path,
    "export function Canary({ s }: { s: string }) {\n  return <div>{eval(s)}</div>;\n}\n",
  );

  expect(result.errors.map((error) => toBail("canary", error))).toStrictEqual([
    { file: "canary", line: 2, reason: "UnsupportedSyntax: The 'eval' function is not supported" },
  ]);
});

test("every component and hook in src is compiled", () => {
  const unexpected = bails.filter((bail) => KNOWN_BAILS[bail.file] === undefined).map(describeBail);

  // a new entry here means that function is no longer memoised in production. Either
  // rework the code, or add it to KNOWN_BAILS with its reason and a note why.
  expect(unexpected).toStrictEqual([]);
});

// One case per recorded bail, so the un-memoised code is named in the output of every
// run rather than sitting silently on an allowlist. These pass while the gap exists;
// they fail when it closes, which is the prompt to delete the entry.
test.each(Object.entries(KNOWN_BAILS))(
  "known bail: %s is still refused by the compiler",
  (file, expectedReason) => {
    const found = bails.filter((bail) => bail.file === file);

    expect(
      found.map(describeBail),
      `${file} compiles now -- delete it from KNOWN_BAILS`,
    ).not.toStrictEqual([]);

    // the reason is pinned too: if it starts failing for a different reason, the note
    // explaining the entry is no longer true and the workaround may be aimed at the
    // wrong thing
    expect(
      found.some((bail) => bail.reason.includes(expectedReason)),
      `${file} bails, but not for the recorded reason. Now: ${found.map((b) => b.reason).join("; ")}`,
    ).toBe(true);
  },
);
