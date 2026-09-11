import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "@babel/core";
import { expect, test } from "vitest";
import { isCompilableSource, reactCompilerOptions, SOURCE_ROOT } from "../../scripts/reactCompiler.mjs";

/**
 * Audits which functions the React Compiler actually compiles.
 *
 * next.config.ts sets reactCompiler: true and the code is written to lean on it -- no
 * hand-written useCallback or useMemo. When the compiler quietly declines a function,
 * nothing fails: the code stays correct and simply stops being memoised, so the loss
 * shows up as a performance regression nobody can trace. This turns that silence into a
 * failing test naming the function and the reason.
 *
 * It runs in the "build" project, which is node rather than browser: it needs a
 * filesystem and babel, and it reads the sources as text rather than importing them.
 */

interface Bail {
  file: string
  line: number | undefined
  reason: string
}

/**
 * Functions the compiler currently refuses, with the reason it gives. These are known
 * gaps, not approvals -- an entry here means that code is un-memoised in production.
 * Delete an entry once the code is reworked; the test below fails on stale entries, so
 * the list cannot quietly outlive the problem.
 */
const KNOWN_BAILS: Record<string, string> = {};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for(const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if(entry.isDirectory()) {
      sourceFiles(path, found);
    } else if(isCompilableSource(path)) {
      found.push(path);
    }
  }

  return found;
}

/** Compile every source file, recording what the compiler accepted and what it refused. */
function auditSourceTree(): { compiled: string[]; bails: Bail[] } {
  const compiled: string[] = [];
  const bails: Bail[] = [];

  for(const path of sourceFiles(SOURCE_ROOT)) {
    const file = relative(SOURCE_ROOT, path);

    transformSync(readFileSync(path, "utf8"), {
      ...reactCompilerOptions(path),
      plugins: [
        [
          "babel-plugin-react-compiler",
          {
            environment: { enableNameAnonymousFunctions: false },
            logger: {
              logEvent: (_filename: string | null, event: { kind: string; fnLoc?: { start?: { line: number } } | null; fnName?: string | null; detail?: { reason?: string; description?: string } }) => {
                if(event.kind === "CompileSuccess") {
                  compiled.push(`${file}:${event.fnName ?? "(anonymous)"}`);
                } else if(event.kind === "CompileError" || event.kind === "CompileSkip" || event.kind === "PipelineError") {
                  bails.push({
                    file,
                    line: event.fnLoc?.start?.line,
                    reason: event.detail?.reason ?? event.detail?.description ?? event.kind
                  });
                }
              }
            }
          }
        ]
      ]
    });
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

test("every component and hook in src is compiled", () => {
  const unexpected = bails
    .filter(bail => KNOWN_BAILS[bail.file] === undefined)
    .map(describeBail);

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
    const found = bails.filter(bail => bail.file === file);

    expect(found.map(describeBail), `${file} compiles now -- delete it from KNOWN_BAILS`)
      .not.toStrictEqual([]);

    // the reason is pinned too: if it starts failing for a different reason, the note
    // explaining the entry is no longer true and the workaround may be aimed at the
    // wrong thing
    expect(
      found.some(bail => bail.reason.includes(expectedReason)),
      `${file} bails, but not for the recorded reason. Now: ${found.map(b => b.reason).join("; ")}`
    ).toBe(true);
  }
);
