import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { classifyLectureTitle, recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * Covers the two halves of the lecture-title rule: what the text box warns about, and what
 * the title turns into on its way to a recording name.
 *
 * They have to agree, and they have not always. A title beginning with "." used to pass the
 * box untouched and then have every single chunk upload rejected with 422 for the length of
 * the lecture -- the backend's SAFE_NAME_REGEX wants a word character first, and 422 is a
 * permanent failure, so there was no retry and no postprocessing either. The recording
 * survived in the OPFS and nowhere else. That rule lives in another language in another
 * process, so the only thing that can hold the two ends together is a test that states it.
 *
 * sanitizedRecordingName is not exported, so the derivation is driven through recordLecture
 * and read out of onStarting, which runs before any media is recorded.
 */

vi.mock("@/lib/utils/serverStorage");

/**
 * Transcribed from SAFE_NAME_REGEX in backend/src/ise_record/settings.py.
 *
 * Python's \w on str patterns is `ch.isalnum() or ch == "_"`: Unicode categories L*, Nd, Nl
 * and No, plus underscore. JS's \w is ASCII-only under every flag, so it has to be spelled
 * out with property escapes -- and those need the u flag, or \p{L} silently degrades to
 * Annex B legacy semantics and matches nearly everything.
 */
const BACKEND_SAFE_NAME = /^[\p{L}\p{Nd}\p{Nl}\p{No}_][\p{L}\p{Nd}\p{Nl}\p{No}_.-]*$/u;

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

// --- what the text box says -------------------------------------------------

test.each([
  [ "GVS", "ok" ],
  [ "", "ok" ], // legal: the name is then just the timestamp
  [ "   ", "ok" ], // trimmed away, so no different from empty
  [ "Übung 3", "ok" ], // spaces are tolerated, and silently dropped later
  [ "Version 1.0", "ok" ], // a dot is fine anywhere but the first character
  [ "3D Modelling", "ok" ], // SAFE_NAME_REGEX takes a leading digit
  [ "_scratch", "ok" ],
  [ "Math 101: Limits", "unsafe-char" ],
  [ "Wie geht's", "unsafe-char" ],
  [ "🎓", "unsafe-char" ],
  [ ".NET", "unsafe-start" ], // would be a hidden directory on the server
  [ "..", "unsafe-start" ],
  [ "-rf", "unsafe-start" ] // ffmpeg would read a leading dash as an option
])("classifyLectureTitle(%j) is %s", (title, expected) => {
  expect(classifyLectureTitle(title)).toBe(expected);
});

test("classification ignores surrounding whitespace, as the derivation does", () => {
  // the two used to disagree here: the box warned about a leading space that the
  // derivation trimmed away without trace
  expect(classifyLectureTitle("  GVS  ")).toBe("ok");
});

test("classification is independent of the composition the keyboard happens to send", () => {
  // Spelled with an escape rather than a literal: the two forms are indistinguishable on
  // screen, so an editor or a git filter normalising this file would quietly turn the
  // interesting half of this test into a copy of the other half.
  const decomposed = "U\u0308bung"; // as macOS input methods and some IMEs send it
  const composed = "\u00dcbung";

  expect(decomposed).not.toBe(composed);

  // a combining mark is not \w, so without the normalize call the decomposed form reads
  // as an unsafe character here and is stripped to "Ubung" on the way to a name
  expect(classifyLectureTitle(decomposed)).toBe("ok");
  expect(classifyLectureTitle(composed)).toBe("ok");
});

// --- what the title becomes -------------------------------------------------

test("a plain title is carried into the name in front of the timestamp", async () => {
  expect(await nameFor("GVS")).toBe(`GVS_${STAMP}`);
});

test("an empty title leaves the timestamp to name the recording", async () => {
  expect(await nameFor("")).toBe(STAMP);
});

test("the timestamp keeps its millisecond dot", async () => {
  // only the colons are unsafe in an ISO timestamp. Sanitising the assembled name rather
  // than the title alone has twice cost the ".789" here, and it is load-bearing in the
  // examples in both doc READMEs and in server.py.
  expect(await nameFor("GVS")).toMatch(/T\d{6}\.\d{3}Z$/);
});

test("spaces close up rather than leaving gaps in a filename", async () => {
  expect(await nameFor("Übung 3")).toBe(`Übung3_${STAMP}`);
  expect(await nameFor("  GVS  ")).toBe(`GVS_${STAMP}`);
});

test("a dot inside the title survives", async () => {
  expect(await nameFor("Version 1.0")).toBe(`Version1.0_${STAMP}`);
});

test("a leading dot never reaches the name", async () => {
  // a recording directory starting with "." would be hidden on the server, where someone
  // eventually has to go looking for it by hand
  expect(await nameFor(".NET")).toBe(`NET_${STAMP}`);
  expect(await nameFor("..")).toBe(`_${STAMP}`);
});

test("a leading dash never reaches the name", async () => {
  // ffmpeg reads an argument starting with "-" as an option
  expect(await nameFor("-rf")).toBe(`rf_${STAMP}`);
});

test("a title with nothing usable in it still yields a name", async () => {
  expect(await nameFor("«»")).toBe(`_${STAMP}`);
});

// --- the two halves agree, and the backend takes the result -----------------

test.each([
  "GVS", "", "   ", "Übung 3", "Version 1.0", "3D Modelling", "_scratch",
  "Math 101: Limits", "Wie geht's", "🎓", ".NET", "..", "-rf", "«»",
  "Übung", "Vorlesung‮gnuselrov‬", "a​b", "../../etc/passwd"
])("the name derived from %j is one the backend accepts", async title => {
  const name = await nameFor(title);

  expect(name).toMatch(BACKEND_SAFE_NAME);
});

test("a title the box refuses still records, it is only warned about", async () => {
  // validate() marks the field but does not stop the user pressing Start, so the
  // derivation has to stand on its own for every title the box merely complains about
  expect(classifyLectureTitle("../../etc/passwd")).not.toBe("ok");
  expect(await nameFor("../../etc/passwd")).toBe(`etcpasswd_${STAMP}`);
});
