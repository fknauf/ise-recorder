import { expect, test } from "vitest";
import { graphemeAwareTruncateToBytes, utf8ByteLength } from "@/lib/utils/stringAux";

/**
 * The two halves of "cut a title down to something a filesystem will take".
 *
 * Both exist because the obvious spellings are wrong in ways that only show up outside
 * Latin script. `substring(0, n)` counts UTF-16 code units and will happily cut a surrogate
 * pair in half; the orphaned half is then encoded as U+FFFD on its way to the server, which
 * is not a word character, which fails the backend's name check, which 422s every chunk
 * upload for the length of the lecture. Counting graphemes instead fixes that but gives up
 * the byte bound, because a cluster carries an unbounded number of combining marks -- 64
 * Devanagari clusters can weigh 768 bytes. So the count and the budget are both load-bearing
 * and both are checked here.
 *
 * TextEncoder is the authority for what a byte length is. utf8ByteLength exists only because
 * calling it per cluster allocated a Uint8Array per cluster and cost an order of magnitude
 * more than the ICU segmentation it was wrapped around, so the tests hold it against the
 * thing it replaced rather than against a hand-computed table.
 */

const utf8 = new TextEncoder();

/** Strings chosen so that every UTF-8 width and every awkward cluster shape appears. */
/* eslint-disable @stylistic/no-multi-spaces -- aligned for legibility */
const CORPUS = [
  "",
  "GVS",
  "Übung 3",                    // 2-byte
  "机器学习",                     // 3-byte, one code point per cluster
  "\u{20000}\u{20001}",         // 4-byte, CJK ext B: two code units per code point
  "a\u{20000}b",                // astral between BMP neighbours
  "हिन्दी",                       // 6 code points, 3 clusters
  "कि॒॑",                         // one cluster, 4 code points, 12 bytes
  "\u{1F468}\u200d\u{1F4BB}",   // emoji ZWJ sequence: one cluster, 11 bytes
  "ภาษาไทย",
  "한국어"
];
/* eslint-enable @stylistic/no-multi-spaces */

// --- utf8ByteLength ---------------------------------------------------------

test.each(CORPUS)("utf8ByteLength(%j) agrees with TextEncoder", str => {
  expect(utf8ByteLength(str)).toBe(utf8.encode(str).length);
});

/* eslint-disable @stylistic/no-multi-spaces -- aligned for legibility */
test.each([
  [ "\u007f", 1 ],  // last 1-byte code point
  [ "\u0080", 2 ],  // first 2-byte
  [ "\u07ff", 2 ],  // last 2-byte
  [ "\u0800", 3 ],  // first 3-byte
  [ "\uffff", 3 ],  // last 3-byte
  [ "\u{10000}", 4 ],  // first 4-byte
  [ "\u{10FFFF}", 4 ]  // last code point there is
])("utf8ByteLength(%j) is %i at the width boundary", (str, expected) => {
  expect(utf8ByteLength(str)).toBe(expected);
});
/* eslint-enable @stylistic/no-multi-spaces */

test("an astral character counts four bytes, not six", () => {
  // the trap in every charCodeAt-based implementation: iterating code units sees two
  // values in the 0x800..0xFFFF range and bills each of them as a 3-byte character
  expect("\u{20000}".length).toBe(2);
  expect(utf8ByteLength("\u{20000}")).toBe(4);
});

test.each([
  [ "lead", "\uD840" ],
  [ "trail", "\uDC00" ]
])("an unpaired %s surrogate is counted the way TextEncoder encodes it", (_half, surrogate) => {
  // an unpaired surrogate has no UTF-8 encoding; TextEncoder substitutes U+FFFD, which is
  // three bytes, and the < 0x10000 branch happens to agree. Pinned because the agreement is
  // a coincidence rather than a decision, and a rewrite could lose it without noticing.
  expect(utf8ByteLength(surrogate)).toBe(utf8.encode(surrogate).length);
});

// --- graphemeAwareTruncateToBytes -------------------------------------------

test.each(CORPUS)("a string that already fits is returned unchanged: %j", str => {
  expect(graphemeAwareTruncateToBytes(str, 192)).toBe(str);
});

test.each([
  [ "ascii", "a".repeat(300), 192, 192 ],
  [ "han", "机".repeat(100), 64, 64 ],
  [ "astral", "\u{20000}".repeat(100), 96, 48 ],
  [ "devanagari", "हि".repeat(100), 64, 32 ],
  [ "emoji zwj", "\u{1F468}\u200d\u{1F4BB}".repeat(100), 85, 17 ]
])("%s truncates to the budget, not to a code unit or cluster count", (_name, str, units, clusters) => {
  const truncated = graphemeAwareTruncateToBytes(str, 192);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  expect(truncated.length).toBe(units);
  expect([ ...segmenter.segment(truncated) ].length).toBe(clusters);
  expect(utf8.encode(truncated).length).toBeLessThanOrEqual(192);
});

test("the budget, not the cluster count, is what bounds the result", () => {
  // 64 clusters is a comfortable title length and, here, a 768-byte directory name: this
  // Devanagari cluster is four code points, so a cluster count alone bounds nothing. That is
  // why an earlier draft carried a maxTitleGraphemes of 64 and was byte-unsafe anyway.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const heavy = "कि॒॑".repeat(80);
  const clustersOf = (str: string) => [ ...segmenter.segment(str) ].map(({ segment }) => segment);

  const sixtyFourClusters = clustersOf(heavy).slice(0, 64);

  expect(utf8ByteLength(sixtyFourClusters.join(""))).toBe(768);

  const truncated = graphemeAwareTruncateToBytes(heavy, 192);

  expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(192);
  expect(clustersOf(truncated).length).toBe(16);
});

test.each([ 0, 1, 3, 11, 64, 192, 1024 ])("nothing exceeds a budget of %i bytes", maxBytes => {
  for(const str of [ ...CORPUS, "a".repeat(300), "机".repeat(100), "\u{20000}".repeat(100), "कि॒॑".repeat(80) ]) {
    expect(utf8ByteLength(graphemeAwareTruncateToBytes(str, maxBytes))).toBeLessThanOrEqual(maxBytes);
  }
});

test.each([ 0, 1, 3, 11, 64, 192 ])("the result is always a prefix of the input at %i bytes", maxBytes => {
  for(const str of [ ...CORPUS, "a".repeat(300), "\u{20000}".repeat(100), "कि॒॑".repeat(80) ]) {
    expect(str.startsWith(graphemeAwareTruncateToBytes(str, maxBytes))).toBe(true);
  }
});

test("a surrogate pair straddling the cut survives whole", () => {
  // the regression this function was written for. 63 ASCII characters put an astral
  // character across the 64th code unit, which is exactly where substring(0, 64) used to cut
  const straddling = "a".repeat(63) + "\u{20000}" + "b".repeat(200);
  const truncated = graphemeAwareTruncateToBytes(straddling, 192);

  expect(truncated).toContain("\u{20000}");
  expect(new TextDecoder().decode(utf8.encode(truncated))).toBe(truncated);
});

test.each([ 0, 1, 2, 3, 4, 5, 64, 65, 66, 67, 191, 192, 193 ])(
  "a cut at %i bytes never orphans half a surrogate pair",
  maxBytes => {
    // encode/decode is the check that matters: an orphaned half becomes U+FFFD on the way
    // out, so a round trip that comes back unchanged is proof there was no orphan. U+FFFD
    // is not a word character and would be rejected by the backend for the whole lecture.
    const astral = "\u{20000}".repeat(50);
    const mixed = "a\u{20000}b\u{20001}c".repeat(30);

    for(const str of [ astral, mixed ]) {
      const truncated = graphemeAwareTruncateToBytes(str, maxBytes);

      expect(new TextDecoder().decode(utf8.encode(truncated))).toBe(truncated);
      expect(truncated).not.toContain("�");
    }
  }
);

test("a cluster is never split across the cut", () => {
  // a Devanagari matra or a Thai vowel sign orphaned from its base renders as a dotted
  // circle, and a ZWJ sequence cut mid-way turns into two unrelated emoji
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const clustersOf = (str: string) => [ ...segmenter.segment(str) ].map(({ segment }) => segment);

  for(const str of [ "हिन्दी व्याकरण ".repeat(20), "\u{1F468}\u200d\u{1F4BB}".repeat(40), "ที่ ".repeat(60) ]) {
    for(const maxBytes of [ 0, 7, 64, 123, 192 ]) {
      const truncated = clustersOf(graphemeAwareTruncateToBytes(str, maxBytes));

      expect(truncated).toEqual(clustersOf(str).slice(0, truncated.length));
    }
  }
});

test("a single cluster wider than the whole budget leaves nothing", () => {
  // better an empty title, which the caller handles by falling back to the bare timestamp,
  // than a fragment of a cluster
  expect(graphemeAwareTruncateToBytes("कि॒॑", 5)).toBe("");
  expect(graphemeAwareTruncateToBytes("\u{20000}", 3)).toBe("");
  expect(graphemeAwareTruncateToBytes("机", 0)).toBe("");
});

test("the early exit agrees with the loop it skips", () => {
  // the function returns without segmenting when the input is under maxBytes/3 code units,
  // on the grounds that a code unit is at most three UTF-8 bytes. If that shortcut is ever
  // wrong it is wrong silently, so it is checked against the budget either side of its edge
  for(const length of [ 62, 63, 64, 65 ]) {
    const ascii = "a".repeat(length);

    expect(graphemeAwareTruncateToBytes(ascii, 192)).toBe(ascii);
  }

  // 3-byte characters are the worst case the shortcut has to survive: 63 of them is 189
  // bytes, just inside the budget it does not check
  const han = "机".repeat(63);

  expect(graphemeAwareTruncateToBytes(han, 192)).toBe(han);
  expect(utf8ByteLength(han)).toBeLessThanOrEqual(192);
});
