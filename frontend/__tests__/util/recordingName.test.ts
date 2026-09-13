import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeLectureTitle, recordLecture, RecordingTrackBundle, sanitizeLectureTitle } from "@/lib/utils/recording";
import { ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * Covers the two halves of the lecture-title rule: what the text box shows the user, and
 * what the title turns into on its way to a recording name.
 *
 * They have to agree, and they have not always. A title beginning with "." used to pass the
 * box untouched and then have every single chunk upload rejected with 422 for the length of
 * the lecture -- the backend's SAFE_NAME_REGEX wants a word character first, and 422 is a
 * permanent failure, so there was no retry and no postprocessing either. The recording
 * survived in the OPFS and nowhere else.
 *
 * Since then the box has stopped guessing and shows the sanitized title instead, which is
 * only an improvement while the string it previews is the string that ends up on disk. That
 * has broken twice in its own right: once because the preview sanitized the title alone
 * while the derivation sanitized title-plus-timestamp, and once because the preview trimmed
 * where the derivation did not, so surrounding spaces became underscores nobody was shown.
 * Both are now structural -- one normalize, one sanitize, used by both ends -- and the tests
 * at the bottom of this file are what keeps them that way.
 *
 * The rule itself lives in another language in another process, so the only thing that can
 * hold the two ends together is a test that states it.
 */

vi.mock("@/lib/utils/serverStorage");

/**
 * Transcribed from SAFE_NAME_REGEX in backend/src/ise_record/settings.py.
 *
 * NOTE: this is the relaxed rule -- \p{M} in the body, which is what lets Devanagari, Thai
 * and any other script whose vowels are combining marks through at all. Until the backend
 * lands it, names containing a mark will pass here and be rejected there; the cases marked
 * below are the ones that tell the two apart.
 *
 * Python's \w on str patterns is `ch.isalnum() or ch == "_"`: Unicode categories L*, Nd, Nl
 * and No, plus underscore, and no marks. JS's \w is ASCII-only under every flag, so it has
 * to be spelled out with property escapes -- and those need the u flag, or \p{L} silently
 * degrades to Annex B legacy semantics and matches nearly everything.
 */
const BACKEND_SAFE_NAME = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.-]*$/u;

/** What the backend will accept as one path component, per NAME_MAX on ext4. */
const NAME_MAX_BYTES = 255;

const utf8 = new TextEncoder();

const destination: ServerStorageDestination = {
  apiUrl: undefined,
  streamingImpeded: false,
  getAccessToken: async () => undefined
};

function singleDisplayBundle(): RecordingTrackBundle {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const display = canvas.captureStream().getVideoTracks()[0];

  return {
    displayTracks: [ display ],
    videoTracks: [],
    audioTracks: [],
    mainDisplay: display,
    overlay: undefined
  };
}

/** The recording name recordLecture derives for a title, at the mocked system time. */
async function nameFor(lectureTitle: string): Promise<string> {
  let recordingName = "";

  await recordLecture(
    singleDisplayBundle(),
    lectureTitle,
    "lecturer@example.com",
    destination,
    name => {
      recordingName = name;
    },
    (_name, stopFunction) => stopFunction(),
    () => {},
    () => {}
  );

  return recordingName;
}

const STAMP = "2025-12-21T123456.789Z";

/**
 * Titles worth carrying through every property below. The non-Latin entries are the point of
 * the exercise: before the rule was relaxed, a Chinese title lost its punctuation and a Hindi
 * one lost its vowels, because \p{Nd} and a missing \p{M} between them threw away everything
 * that was not a letter or an ASCII digit.
 */
const TITLES = [
  "GVS", "", "   ", "Übung 3", "Version 1.0", "3D Modelling", "_scratch",
  "Math 101: Limits", "Wie geht's", "\u{1F393}", ".NET", "..", "-rf", "«»",
  "  GVS  ", "U\u0308bung", "Vorlesung\u202egnuselrov\u202c", "a\u200bb",
  "../../etc/passwd", "机器学习（第一讲）", "数据结构、算法", "हिन्दी व्याकरण",
  "ภาษาไทย", "한국어 강의", "Tiếng Việt", "a".repeat(400), "机".repeat(200)
];

// --- what the box previews --------------------------------------------------

/* eslint-disable @stylistic/no-multi-spaces -- aligned for legibility */
test.each([
  [ "GVS", "GVS" ],
  [ "", "" ],
  [ "   ", "" ],                              // trimmed away, so no different from empty
  [ "  GVS  ", "GVS" ],
  [ "Übung 3", "Übung_3" ],                   // spaces become separators rather than closing up
  [ "Version 1.0", "Version_1.0" ],           // a dot is fine anywhere but the first character
  [ "3D Modelling", "3D_Modelling" ],         // a leading digit is a legal first character
  [ "_scratch", "_scratch" ],                 // and so is an underscore
  [ "Math 101: Limits", "Math_101_Limits" ],
  [ "Wie geht's", "Wie_gehts" ],
  [ "\u{1F393}", "" ],
  [ ".NET", "NET" ],                          // would be a hidden directory on the server
  [ "..", "" ],
  [ "-rf", "rf" ],                            // ffmpeg would read a leading dash as an option
  [ "«»", "" ],
  [ "../../etc/passwd", "etcpasswd" ]
])("sanitizeLectureTitle(%j) is %j", (title, expected) => {
  expect(sanitizeLectureTitle(title)).toBe(expected);
});

test.each([
  [ "机器学习（第一讲）", "机器学习第一讲" ],       // fullwidth parens are Ps/Pe, not letters
  [ "数据结构、算法", "数据结构算法" ],            // the ideographic comma is Po
  [ "第1讲：绪论", "第1讲绪论" ],
  [ "हिन्दी व्याकरण", "हिन्दी_व्याकरण" ],      // vowel signs are Mc/Mn and must survive
  [ "ภาษาไทย", "ภาษาไทย" ],
  [ "한국어 강의", "한국어_강의" ],
  [ "Tiếng Việt", "Tiếng_Việt" ],
  [ "العربية", "العربية" ]
])("a non-Latin title keeps its own script: %j becomes %j", (title, expected) => {
  // the whole point of relaxing the rule. \p{Nd} alone used to strip Nl and No, and the
  // missing \p{M} took every Indic vowel with it -- "हिन्दी" came out as "हनद"
  expect(sanitizeLectureTitle(title)).toBe(expected);
});
/* eslint-enable @stylistic/no-multi-spaces */

test("a zero-width or bidi control character never survives", () => {
  // U+202E reverses the rendering of everything after it, which is the oldest trick there is
  // for making a directory look like something it is not. Cf is outside L, M and N, so the
  // relaxed rule still drops it -- stated here because "allow more Unicode" is the kind of
  // change that would quietly take it back.
  expect(sanitizeLectureTitle("Vorlesung\u202egnuselrov\u202c")).toBe("Vorlesunggnuselrov");
  expect(sanitizeLectureTitle("a\u200bb")).toBe("ab");
  expect(sanitizeLectureTitle("a\u200db")).toBe("ab");
});

test("the preview is independent of the composition the keyboard happens to send", () => {
  // Spelled with an escape rather than a literal: the two forms are indistinguishable on
  // screen, so an editor or a git filter normalising this file would quietly turn the
  // interesting half of this test into a copy of the other half.
  const decomposed = "U\u0308bung"; // as macOS input methods and some IMEs send it
  const composed = "\u00dcbung";

  expect(decomposed).not.toBe(composed);
  expect(sanitizeLectureTitle(decomposed)).toBe(composed);
  expect(sanitizeLectureTitle(composed)).toBe(composed);
});

test.each([ "GVS", "Übung 3", "机器学习", "한국어 강의", "हिन्दी", "U\u0308bung", "  GVS  ", "", "   " ])("the box stays quiet about %j, which survives intact", title => {
  // validateLectureTitle shows a message exactly when the sanitized title differs from the
  // normalized one, so a title that only gains separators or a composition must compare
  // equal or the user is told about a change they cannot see. The decomposed entry is the
  // regression: without the normalize on both sides it reported "sanitizes to Übung".
  expect(sanitizeLectureTitle(title)).toBe(normalizeLectureTitle(title));
});

test.each([ "机器学习（第一讲）", ".NET", "-rf", "Math 101: Limits", "«»" ])(
  "the box speaks up about %j, which does not",
  title => {
    expect(sanitizeLectureTitle(title)).not.toBe(normalizeLectureTitle(title));
  }
);

test("an all-whitespace title is treated as no title at all", () => {
  // the empty-title branch of validateLectureTitle keys off the normalized string, so these
  // two have to agree or "   " is reported as sanitizing to nothing while "" passes silently
  expect(normalizeLectureTitle("   ")).toBe("");
  expect(normalizeLectureTitle("")).toBe("");
});

test("normalizing is idempotent", () => {
  // it runs on both sides of the comparison the box makes, so a second pass that changed
  // anything would make the message flicker on titles that are already settled
  const unstable: Record<string, { once: string; twice: string }> = {};

  for(const title of TITLES) {
    const once = normalizeLectureTitle(title);
    const twice = normalizeLectureTitle(once);

    if(once !== twice) {
      unstable[label(title)] = { once: label(once), twice: label(twice) };
    }
  }

  expect(unstable).toEqual({});
});

// --- what the title becomes -------------------------------------------------

beforeEach(() => {
  vi.setSystemTime("2025-12-21T12:34:56.789Z");
});

afterEach(async () => {
  vi.useRealTimers();

  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }
});

test("a plain title is carried into the name in front of the timestamp", async () => {
  expect(await nameFor("GVS")).toBe(`GVS_${STAMP}`);
});

test("an empty title leaves the timestamp to name the recording", async () => {
  expect(await nameFor("")).toBe(STAMP);
});

test("a title with nothing usable in it also leaves just the timestamp", async () => {
  // it used to leave a bare "_" in front, because the separator was appended before anyone
  // asked whether there was a title left to separate
  expect(await nameFor("«»")).toBe(STAMP);
  expect(await nameFor("..")).toBe(STAMP);
  expect(await nameFor("\u{1F393}")).toBe(STAMP);
});

test("the timestamp keeps its millisecond dot", async () => {
  // only the colons are unsafe in an ISO timestamp. Sanitising the assembled name rather
  // than the title alone has twice cost the ".789" here, and it is load-bearing in the
  // examples in both doc READMEs and in server.py.
  expect(await nameFor("GVS")).toMatch(/T\d{6}\.\d{3}Z$/);
});

test("the timestamp is appended after sanitising, not put through it", async () => {
  // it is the only thing making two recordings of the same lecture distinguishable, so it
  // must not be reachable by anything the title does -- including truncation, which would
  // otherwise cut the disambiguator off the end and merge two lectures into one directory
  const longTitle = await nameFor("a".repeat(400));
  const otherLongTitle = await nameFor("b" + "a".repeat(399));

  expect(longTitle.endsWith(STAMP)).toBe(true);
  expect(otherLongTitle.endsWith(STAMP)).toBe(true);
  expect(longTitle).not.toBe(otherLongTitle);
});

test.each([
  [ "Übung 3", `Übung_3_${STAMP}` ],
  [ "  GVS  ", `GVS_${STAMP}` ],
  [ "Version 1.0", `Version_1.0_${STAMP}` ],
  [ ".NET", `NET_${STAMP}` ],
  [ "-rf", `rf_${STAMP}` ],
  [ "../../etc/passwd", `etcpasswd_${STAMP}` ],
  [ "机器学习（第一讲）", `机器学习第一讲_${STAMP}` ],
  [ "हिन्दी व्याकरण", `हिन्दी_व्याकरण_${STAMP}` ]
])("the name derived from %j is %j", async (title, expected) => {
  expect(await nameFor(title)).toBe(expected);
});

// --- the two halves agree, and the backend takes the result -----------------

/**
 * The three properties below hold for every title rather than for a listed few, so they are
 * written as one test each that collects its counterexamples instead of one test per title.
 * A change that breaks the rule breaks it for most of the corpus at once, and 27 near-identical
 * red lines per browser bury the one thing worth reading. Collecting rather than asserting
 * inside the loop is what keeps that readable: the whole set of offending titles lands in a
 * single diff, where stopping at the first failure would show only the first one in the list.
 */

/**
 * A title or name as it should appear in a failure: short enough not to crowd out its
 * neighbours, long enough to still show the whole of a realistic one. The corpus holds a
 * 400-character title deliberately, and printed whole it buries the other 26; the cutoff sits
 * above title-plus-timestamp so that everything short of that deliberate case reads in full.
 */
function label(str: string) {
  return str.length <= 64
    ? JSON.stringify(str)
    : `${JSON.stringify(str.slice(0, 48))}...(${str.length} chars)`;
}

test("every derived name is one the backend accepts", async () => {
  const rejected: string[] = [];

  for(const title of TITLES) {
    const name = await nameFor(title);

    if(!BACKEND_SAFE_NAME.test(name)) {
      rejected.push(`${label(title)} -> ${label(name)}`);
    }
  }

  expect(rejected).toEqual([]);
});

test("every derived name fits in one path component", async () => {
  // the failure this guards is not a rejection but an OSError out of os.makedirs, halfway
  // through a lecture, on every chunk. CJK costs three bytes a character, so a title that
  // is comfortable in German can be twice over the limit in Chinese
  const oversized: string[] = [];

  for(const title of TITLES) {
    const bytes = utf8.encode(await nameFor(title)).length;

    if(bytes > NAME_MAX_BYTES) {
      oversized.push(`${label(title)} -> ${bytes} bytes`);
    }
  }

  expect(oversized).toEqual([]);
});

test("what the box previews is what the name is built from", async () => {
  // the invariant that has broken twice. Everything else in this file is a consequence of
  // it, and it is the one that cannot be checked by reading either side on its own
  const disagreements: Record<string, { previewed: string; derived: string }> = {};

  for(const title of TITLES) {
    const previewed = sanitizeLectureTitle(title);
    const derived = await nameFor(title);
    const expected = previewed === "" ? STAMP : `${previewed}_${STAMP}`;

    if(derived !== expected) {
      disagreements[label(title)] = { previewed: label(previewed), derived: label(derived) };
    }
  }

  expect(disagreements).toEqual({});
});

test("a title the box complains about still records", async () => {
  // validate() marks the field but does not stop the user pressing Start, so the derivation
  // has to stand on its own for every title the box merely complains about
  expect(sanitizeLectureTitle("../../etc/passwd")).not.toBe(normalizeLectureTitle("../../etc/passwd"));
  expect(await nameFor("../../etc/passwd")).toBe(`etcpasswd_${STAMP}`);
});
