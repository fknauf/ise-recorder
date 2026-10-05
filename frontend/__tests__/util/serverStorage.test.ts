import { afterEach, expect, test, vi } from "vitest";
import { downloadHref, fetchRecordings, purgeRecording, schedulePostprocessing, uploadChunk, uploadFile } from "@/lib/utils/serverStorage";
import { ApiDestination, ApiError, defaultRetryPolicy, RetryPolicy, withRetries } from "@/lib/utils/apiFetch";
import { showError, showMessage, showSuccess } from "@/lib/utils/notifications";
import * as z from "zod";

vi.mock("@/lib/utils/notifications", () => ({
  // An explicit factory, not automocking: vi.mock() alone yields spies that still call
  // through, so the real showError logs and queues Spectrum toasts during the suite.
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));

const accessToken = async () => "test-token";
const noAccessToken = async () => undefined;

const useRetryClock = () => vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

// for the tests that are not about retrying: fail on the first refusal, without waiting
const noRetries: RetryPolicy = { ...defaultRetryPolicy, retries: 0, initialWaitMillis: 0 };

const retrying = (overrides: Partial<RetryPolicy>): RetryPolicy => ({ ...defaultRetryPolicy, ...overrides });

// Captured before any test installs a fake clock, so we can still yield to the real
// event loop while one is installed.
const realSetTimeout = globalThis.setTimeout;

/**
 * Run a retry loop to completion under a fake clock.
 *
 * vi.runAllTimersAsync() inspects the timer queue at the moment it is called. When a
 * retry loop starts, the first attempt is still in flight -- it awaits getAccessToken()
 * and then fetch() -- so no backoff timer exists yet and the drain returns having fired
 * nothing and advanced nothing. Each subsequent attempt has the same shape. So alternate
 * between yielding to the real event loop (letting the in-flight attempt land and
 * schedule its backoff) and draining the fake queue (firing that backoff), until the
 * call settles.
 */
async function settleRetries<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = pending.then(
    value => {
      settled = true;
      return value;
    },
    error => {
      settled = true;
      throw error;
    }
  );

  // a rejection is the caller's to assert on once this returns, not an unhandled one while
  // the loop is still running
  tracked.catch(() => {});

  for(let guard = 0; !settled && guard < 100; ++guard) {
    await new Promise(resolve => realSetTimeout(resolve, 0));
    await vi.runAllTimersAsync();
  }

  return tracked;
}

/** The Request the nth call to fetch() received; the code under test hands it nothing else. */
const fetchedRequest = (n = 0) => vi.mocked(window.fetch).mock.calls[n][0] as Request;

/** What a call rejected with, for the assertions toThrow() cannot make. */
const rejectionOf = (pending: Promise<unknown>) => pending.then(
  () => {
    throw new Error("expected the call to fail");
  },
  (e: unknown) => e
);

const API = "http://record.example.com/";

const destination: ApiDestination = {
  apiUrl: API,
  getAccessToken: accessToken
};

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(showError).mockClear();
  vi.mocked(showSuccess).mockClear();
  vi.mocked(showMessage).mockClear();
});

// --- streaming a chunk -------------------------------------------------------

const chunkUrl = (recording: string, track: string, index: number) =>
  `${API}api/recordings/${recording}/tracks/${track}/chunks/${index}`;

test("sending chunk to server", async () => {
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });

  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await expect(uploadChunk(destination, chunk, "FOO", "stream.webm", 42, undefined)).resolves.toBeUndefined();

  const request = fetchedRequest();

  expect(request.url).toBe(chunkUrl("FOO", "stream.webm", 42));
  expect(request.method).toBe("PUT");
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
  // the chunk is the body as it is, which the backend streams to disk
  expect(await request.text()).toStrictEqual(await chunk.text());
});

test("recording and track names are percent-encoded into the chunk path", async () => {
  // each is one path segment, so a slash in either must not start another
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await uploadChunk(destination, new Blob([ "x" ]), "Übung_2025", "audio/0", 7, undefined);

  expect(fetchedRequest().url).toBe(chunkUrl(encodeURIComponent("Übung_2025"), encodeURIComponent("audio/0"), 7));
});

test("sending chunk to flaky server", async () => {
  // how a live recording sends its chunks: the same chunk again, until one arrives
  useRetryClock();

  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return new Response(null, { status: 204 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      throw new TypeError("Failed to fetch");
    });

  const pending = withRetries(() => uploadChunk(destination, chunk, "FOO", "stream.webm", 42, undefined), retrying({ retries: 10, initialWaitMillis: 50 }));

  await expect(settleRetries(pending)).resolves.toBeUndefined();

  expect(fetchRequests.length).toBe(2);

  for(const req of fetchRequests) {
    expect(req.url).toBe(chunkUrl("FOO", "stream.webm", 42));
    expect(req.method).toBe("PUT");
    expect(await req.text()).toStrictEqual(await chunk.text());
  }
});

test("sending chunk to broken server", async () => {
  useRetryClock();

  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json("", { status: 503 });
    });

  const before = Date.now();
  const pending = withRetries(() => uploadChunk(destination, chunk, "FOO", "stream.webm", 42, undefined), retrying({ retries: 3, initialWaitMillis: 50 }));

  const error = await settleRetries(rejectionOf(pending));

  const elapsed = Date.now() - before;

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toContain("503");

  // Telling the user is the caller's business: during a recording several chunks give up
  // at once, and only the first of them may say so.
  expect(vi.mocked(showError)).not.toHaveBeenCalled();

  // one attempt and three retries, backing off 50 + 100 + 200
  expect(fetchRequests.length).toBe(4);
  expect(elapsed).toBe(350);

  for(const req of fetchRequests) {
    expect(req.url).toBe(chunkUrl("FOO", "stream.webm", 42));
    expect(req.method).toBe("PUT");
    expect(await req.text()).toStrictEqual(await chunk.text());
  }
});

test("a chunk rejected by the backend fails with the server's explanation", async () => {
  // what the backend answers once a lecture has outrun the chunk numbering
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Lecture has been going on too long." }, { status: 422 }));

  const error = await rejectionOf(uploadChunk(destination, new Blob([ "x" ]), "FOO", "stream.webm", 42, undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(422);
  expect((error as ApiError).detail).toBe("Lecture has been going on too long.");
});

test("chunk upload is unauthenticated if no access token is available", async () => {
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });

  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await uploadChunk({ ...destination, getAccessToken: noAccessToken }, chunk, "FOO", "stream.webm", 42, undefined);

  expect(fetchedRequest().headers.has("Authorization")).toBe(false);
});

test("chunk upload requests a fresh access token for every attempt", async () => {
  useRetryClock();

  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: Request[] = [];

  // A recording outlives its access token, so a retry must not reuse the token that
  // was current when the first attempt failed -- least of all when the failure was the
  // backend turning that token away.
  let issuedTokens = 0;
  const rotatingAccessToken = async () => `test-token-${++issuedTokens}`;

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return new Response(null, { status: 204 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json({ detail: "Not authenticated" }, { status: 401 });
    });

  const pending = withRetries(
    () => uploadChunk({ apiUrl: API, getAccessToken: rotatingAccessToken }, chunk, "FOO", "stream.webm", 42, undefined),
    retrying({ retries: 10, initialWaitMillis: 50 })
  );

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);
  expect(fetchRequests[0].headers.get("Authorization")).toBe("Bearer test-token-1");
  expect(fetchRequests[1].headers.get("Authorization")).toBe("Bearer test-token-2");
});

test("an upload on an aborted signal sends nothing", async () => {
  const aborted = new AbortController();
  aborted.abort("chunk");
  window.fetch = vi.fn();

  // the abort's reason rather than an ApiError, so the caller can tell it from a failure
  expect(await rejectionOf(uploadChunk(destination, new Blob([ "x" ]), "FOO", "stream", 0, aborted.signal))).toBe("chunk");
  expect(window.fetch).not.toHaveBeenCalled();
});

test.each([
  [ "with", accessToken ],
  [ "without", noAccessToken ]
])("the abort signal reaches the chunk request %s an access token", async (_, getAccessToken) => {
  // an anonymous backend deployment has no token, and its requests must be cancellable too
  const controller = new AbortController();
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await uploadChunk({ apiUrl: API, getAccessToken }, new Blob([ "x" ]), "FOO", "stream", 0, controller.signal);

  // the Request follows the signal it was built with rather than being that signal
  const request = fetchedRequest();
  expect(request.signal.aborted).toBe(false);
  controller.abort("chunk");
  expect(request.signal.reason).toBe("chunk");
});

// --- scheduling postprocessing -----------------------------------------------

const ACCEPTED_JOB = { state: "rendering", name: "FOO" };

const acceptingServer = () =>
  vi.fn().mockImplementation(async () => Response.json(ACCEPTED_JOB, { status: 202 }));

test("schedule postprocessing", async () => {
  window.fetch = acceptingServer();

  await schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined);

  const request = fetchedRequest();

  expect(request.url).toBe(`${API}api/recordings/FOO/render`);
  expect(request.method).toBe("POST");
  expect(request.headers.get("Content-Type")).toBe("application/json");
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");

  // the recording is in the path now, so the body is only what is to be done with it
  expect(await request.json()).toStrictEqual({ recipient: "lecturer@example.com" });
});

test("schedule postprocessing without a recipient sends none", async () => {
  // a lecturer who gave no address gets no completion report, and the render still happens
  window.fetch = acceptingServer();

  await schedulePostprocessing(destination, "FOO", undefined, undefined);

  expect(await fetchedRequest().json()).toStrictEqual({});
});

test("the recording to postprocess is percent-encoded into the path", async () => {
  window.fetch = vi.fn().mockImplementation(async () => Response.json({ state: "rendering", name: "Übung_2025" }, { status: 202 }));

  await schedulePostprocessing(destination, "Übung_2025", undefined, undefined);

  expect(fetchedRequest().url).toBe(`${API}api/recordings/${encodeURIComponent("Übung_2025")}/render`);
});

test("schedule postprocessing to flaky server", async () => {
  useRetryClock();

  const fetchRequests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json(ACCEPTED_JOB, { status: 202 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json("", { status: 503 });
    });

  const pending = withRetries(
    () => schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined),
    retrying({ retries: 5, initialWaitMillis: 50 })
  );

  await expect(settleRetries(pending)).resolves.toStrictEqual(ACCEPTED_JOB);

  expect(fetchRequests.length).toBe(2);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${API}api/recordings/FOO/render`);
    expect(req.method).toBe("POST");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.headers.get("Authorization")).toBe("Bearer test-token");
    expect(await req.json()).toStrictEqual({ recipient: "lecturer@example.com" });
  }
});

test("schedule postprocessing to broken server", async () => {
  useRetryClock();

  const fetchRequests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      throw new TypeError("Failed to fetch");
    });

  const before = Date.now();
  const pending = withRetries(
    () => schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined),
    retrying({ retries: 3, initialWaitMillis: 50 })
  );

  const error = await settleRetries(rejectionOf(pending));

  const elapsed = Date.now() - before;

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("network");
  expect(fetchRequests.length).toBe(4);
  expect(elapsed).toBe(350);
  // the caller says so: a live recording and the Rerender button have different advice
  expect(vi.mocked(showError)).not.toHaveBeenCalled();

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${API}api/recordings/FOO/render`);
    expect(req.method).toBe("POST");
    expect(await req.json()).toStrictEqual({ recipient: "lecturer@example.com" });
  }
});

// The result is the whole of the report: telling the lecturer is the caller's business,
// because only the caller knows what to tell them -- a live recording that was streamed in
// full can be rerendered later, a press of the Rerender button can simply be retried. So
// none of these raise a toast of their own.

test("schedule postprocessing reports an accepted job", async () => {
  window.fetch = acceptingServer();

  // the recording as it stands now, for the listing to show without fetching it again
  await expect(schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined)).resolves.toStrictEqual(ACCEPTED_JOB);
  expect(vi.mocked(showSuccess)).not.toHaveBeenCalled();
  expect(vi.mocked(showMessage)).not.toHaveBeenCalled();
  expect(vi.mocked(showError)).not.toHaveBeenCalled();
});

test("schedule postprocessing reports a refused job", async () => {
  // what the backend answers for a recording that does not exist
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Recording FOO does not exist" }, { status: 404 }));

  const error = await rejectionOf(schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(404);
  expect((error as ApiError).message).toContain("Recording FOO does not exist");
  expect(vi.mocked(showError)).not.toHaveBeenCalled();
  expect(vi.mocked(showSuccess)).not.toHaveBeenCalled();
});

test("an accepted job the backend does not describe is an invalid response", async () => {
  // a backend from before the API was reshaped accepted a job with an empty body
  window.fetch = vi.fn().mockImplementation(async () => Response.json("", { status: 202 }));

  const error = await rejectionOf(schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("invalid-response");
  expect((error as ApiError).cause).toBeInstanceOf(z.ZodError);
});

test("an accepted job that is not rendering is an invalid response", async () => {
  // the listing knows unprocessed recordings, but a job the backend has just taken on is
  // rendering by definition; anything else means frontend and backend disagree
  window.fetch = vi.fn().mockImplementation(async () => Response.json({ state: "unprocessed", name: "FOO" }, { status: 202 }));

  const error = await rejectionOf(schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("invalid-response");
  expect((error as ApiError).cause).toBeInstanceOf(z.ZodError);
});

test.each([ 400, 404, 409, 422 ])("postprocessing rejected with %i is not retried", async status => {
  useRetryClock();

  window.fetch = vi.fn().mockImplementation(async () => Response.json("", { status }));

  const error = await settleRetries(rejectionOf(withRetries(
    () => schedulePostprocessing(destination, "FOO", "lecturer@example.com", undefined),
    retrying({ retries: 3, initialWaitMillis: 50 })
  )));

  expect(window.fetch).toHaveBeenCalledOnce();
  expect((error as ApiError).status).toBe(status);
});

test("schedule postprocessing after aborted streaming sends nothing and reports the abort", async () => {
  // A recording whose chunks did not all arrive: rendering it would produce a video with a
  // hole in it, and the lecturer would be told it had worked.
  const aborted = new AbortController();
  aborted.abort("chunk");

  window.fetch = vi.fn();

  const error = await rejectionOf(schedulePostprocessing(destination, "FOO", "lecturer@example.com", aborted.signal));

  // told apart from a failure: the lecturer is not to be told the backend refused anything
  expect(error).toBe("chunk");
  expect(error).not.toBeInstanceOf(ApiError);
  expect(window.fetch).not.toHaveBeenCalled();
  expect(vi.mocked(showMessage)).not.toHaveBeenCalled();
  expect(vi.mocked(showSuccess)).not.toHaveBeenCalled();
  expect(vi.mocked(showError)).not.toHaveBeenCalled();
});

test("postprocessing request is unauthenticated if no access token is available", async () => {
  window.fetch = acceptingServer();

  await schedulePostprocessing({ ...destination, getAccessToken: noAccessToken }, "FOO", "lecturer@example.com", undefined);

  expect(fetchedRequest().headers.has("Authorization")).toBe(false);
  expect(fetchedRequest().headers.get("Content-Type")).toBe("application/json");
});

test("postprocessing request requests a fresh access token for every attempt", async () => {
  useRetryClock();

  const fetchRequests: Request[] = [];

  let issuedTokens = 0;
  const rotatingAccessToken = async () => `test-token-${++issuedTokens}`;

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json(ACCEPTED_JOB, { status: 202 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      fetchRequests.push(request);
      return Response.json({ detail: "Not authenticated" }, { status: 401 });
    });

  const pending = withRetries(
    () => schedulePostprocessing({ apiUrl: API, getAccessToken: rotatingAccessToken }, "FOO", "lecturer@example.com", undefined),
    retrying({ retries: 5, initialWaitMillis: 50 })
  );

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);
  expect(fetchRequests[0].headers.get("Authorization")).toBe("Bearer test-token-1");
  expect(fetchRequests[1].headers.get("Authorization")).toBe("Bearer test-token-2");
  expect(fetchRequests[1].headers.get("Content-Type")).toBe("application/json");
});

// --- the listing -------------------------------------------------------------
//
// What the processed recordings section shows. A completed recording comes with the path it
// can be downloaded from; the others only have a name and the state they are in.

const LISTING = [
  { state: "completed", name: "PSU_2026", size: 2048, downloadUrl: "downloads/8f14e45fceea167a/PSU_2026?totp=9876543210" },
  { state: "rendering", name: "ABC_2026" },
  { state: "unprocessed", name: "GVS_2025" }
];

test("the listing is fetched with one authenticated GET", async () => {
  window.fetch = vi.fn().mockResolvedValue(Response.json(LISTING));

  await fetchRecordings(destination);

  expect(window.fetch).toHaveBeenCalledOnce();

  const request = fetchedRequest();
  expect(request.url).toBe(`${API}api/recordings`);
  expect(request.method).toBe("GET");
  expect(request.headers.get("Accept")).toBe("application/json");
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
});

test("the listing resolves with the recordings the backend answered with", async () => {
  window.fetch = vi.fn().mockResolvedValue(Response.json(LISTING));

  await expect(fetchRecordings(destination)).resolves.toStrictEqual(LISTING);
});

test("a listing with nothing in it is an empty array", async () => {
  window.fetch = vi.fn().mockResolvedValue(Response.json([]));

  await expect(fetchRecordings(destination)).resolves.toStrictEqual([]);
});

test.each([
  [ "in the shape from before the API was reshaped", { user: "8f14e45fceea167a", completed: [], rendering: [], unprocessed: [] } ],
  [ "with a completed recording that cannot be downloaded", [ { state: "completed", name: "PSU_2026", size: 2048 } ] ],
  [ "with a recording in a state the frontend does not know", [ { state: "archived", name: "PSU_2026" } ] ]
])("a listing %s is an invalid response", async (_, listing) => {
  // the section tells the lecturer the backend speaks a different version, rather than
  // showing a listing it cannot make sense of
  window.fetch = vi.fn().mockResolvedValue(Response.json(listing));

  const error = await rejectionOf(fetchRecordings(destination));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("invalid-response");
  expect((error as ApiError).cause).toBeInstanceOf(z.ZodError);
});

test("a refused listing fails with the server's explanation", async () => {
  // what a backend deployed without authentication answers
  window.fetch = vi.fn().mockResolvedValue(
    Response.json({ detail: "Authentication not configured" }, { status: 403 }));

  const error = await rejectionOf(fetchRecordings(destination));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(403);
  expect((error as ApiError).detail).toBe("Authentication not configured");
});

// --- purging ---------------------------------------------------------------
//
// The request that deletes a recording for good. What the lecturer has to confirm first,
// and telling them how it went, is the dialog's business, in
// ServerStorageSection.test.tsx; this is the request once they have confirmed.

const purged = () => new Response(null, { status: 204 });

test("a purge sends one authenticated DELETE for the recording", async () => {
  window.fetch = vi.fn().mockResolvedValue(purged());

  await purgeRecording(destination, "GVS_2025");

  expect(window.fetch).toHaveBeenCalledOnce();

  const request = fetchedRequest();
  expect(request.url).toBe(`${API}api/recordings/GVS_2025`);
  expect(request.method).toBe("DELETE");
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
});

test("a purged recording name is percent-encoded into the path", async () => {
  // a name is a path segment here, so anything the browser would not encode on its own
  // has to be encoded before it gets there
  window.fetch = vi.fn().mockResolvedValue(purged());

  await purgeRecording(destination, "Übung/2025");

  expect(fetchedRequest().url).toBe(`${API}api/recordings/${encodeURIComponent("Übung/2025")}`);
});

test("a successful purge resolves with nothing", async () => {
  // the backend answers 204; the section drops the recording from its listing itself
  window.fetch = vi.fn().mockResolvedValue(purged());

  await expect(purgeRecording(destination, "GVS_2025")).resolves.toBeUndefined();
  // the dialog tells the lecturer; a toast from here as well would be a second one
  expect(showSuccess).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
});

test("a purge without an access token is left to the backend to refuse", async () => {
  // anonymous deployments have no token at all, so whether one is needed is the backend's call
  window.fetch = vi.fn().mockResolvedValue(Response.json({ detail: "Not authenticated" }, { status: 401 }));

  const error = await rejectionOf(purgeRecording({ ...destination, getAccessToken: noAccessToken }, "GVS_2025"));

  expect(fetchedRequest().headers.has("Authorization")).toBe(false);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(401);
  expect((error as ApiError).detail).toBe("Not authenticated");
});

test("a refused purge fails with the server's explanation", async () => {
  // a 409 means the listing was stale -- the recording started rendering in the meantime
  window.fetch = vi.fn().mockResolvedValue(
    Response.json({ detail: "Recording GVS_2025 is in use and currently not purgeable" }, { status: 409 })
  );

  const error = await rejectionOf(purgeRecording(destination, "GVS_2025"));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(409);
  expect((error as ApiError).detail).toBe("Recording GVS_2025 is in use and currently not purgeable");
  expect((error as ApiError).message).toBe("HTTP 409: Recording GVS_2025 is in use and currently not purgeable");
  expect(showError).not.toHaveBeenCalled();
});

test("a refusal whose detail is not a string is not stringified", async () => {
  // FastAPI answers a validation failure with an array of issue objects
  window.fetch = vi.fn().mockResolvedValue(
    Response.json({ detail: [ { loc: [ "path", "recording" ], msg: "String should match pattern" } ] }, { status: 422 })
  );

  const error = await rejectionOf(purgeRecording(destination, "GVS_2025"));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toBe("HTTP 422");
  expect((error as ApiError).message).not.toContain("[object Object]");
});

test("a refusal that is not JSON still says something", async () => {
  window.fetch = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

  const error = await rejectionOf(purgeRecording(destination, "GVS_2025"));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toBe("HTTP 502");
  // a gateway's error page is not something to put in a toast
  expect((error as ApiError).message).not.toContain("<html>");
});

test("a backend that cannot be reached fails the purge with fetch's own error", async () => {
  // what fetch() said is the only clue to which of the many ways of not arriving it was,
  // and the dialog puts it in the toast
  const unreachable = new TypeError("NetworkError when attempting to fetch resource.");
  window.fetch = vi.fn().mockRejectedValue(unreachable);

  const error = await rejectionOf(purgeRecording(destination, "GVS_2025"));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("network");
  expect((error as ApiError).cause).toBe(unreachable);
  expect((error as ApiError).message).toContain(unreachable.message);
});

// --- downloading -------------------------------------------------------------
//
// The backend hands out a download path relative to its API, with the recording name already
// encoded and the OTP in the query; the link only has to be put below the API.

const completed = (downloadUrl: string) => ({ state: "completed" as const, name: "Übung_2025", size: 2048, downloadUrl });

test("the download URL is the backend's download path below the API", () => {
  const encodedName = encodeURIComponent("Übung_2025");

  expect(downloadHref(API, completed(`downloads/8f14e45f/${encodedName}?totp=0123456789`)))
    .toBe(`${API}api/downloads/8f14e45f/${encodedName}?totp=0123456789`);
});

test("the recording name in the download URL is not encoded a second time", () => {
  // %C3%9C turning into %25C3%259C would ask the backend for a recording that does not exist
  expect(downloadHref(API, completed("downloads/8f14e45f/%C3%9Cbung_2025?totp=0123456789")))
    .not.toContain("%25");
});

test("the download URL keeps a path prefix of the API URL", () => {
  // a backend behind a reverse proxy, under a path of its own
  expect(downloadHref("https://example.com/ise/", completed("downloads/8f14e45f/PSU_2026?totp=0123456789")))
    .toBe("https://example.com/ise/api/downloads/8f14e45f/PSU_2026?totp=0123456789");
});

// --- uploading a whole file in chunks --------------------------------------
//
// The manual re-upload sends a locally saved track the same way the live recording does:
// as numbered chunks, which the backend joins byte for byte. So the split points can fall
// anywhere, and what matters is that the pieces add up to the file, in order, with no gap.

const MiB = 2 ** 20;
const CHUNK = 4 * MiB;

const CHUNK_PATH = /^\/api\/recordings\/([^/]+)\/tracks\/([^/]+)\/chunks\/(\d+)$/;

/** Every chunk request fetch() received, with what the backend reads from its path. */
async function sentChunks() {
  return Promise.all(vi.mocked(window.fetch).mock.calls.map(async ([ input ]) => {
    const request = input as Request;
    const url = new URL(request.url);
    const [ , recording, track, index ] = url.pathname.match(CHUNK_PATH) ?? [];

    return {
      url: request.url,
      origin: url.origin,
      method: request.method,
      recording: decodeURIComponent(recording),
      track: decodeURIComponent(track),
      index: Number(index),
      bytes: new Uint8Array(await request.arrayBuffer())
    };
  }));
}

function fileOf(size: number) {
  // a byte pattern that does not repeat at the chunk size, so a chunk sent twice or out of
  // order would not add up to the same bytes by accident
  const bytes = new Uint8Array(size);
  for(let i = 0; i < size; ++i) {
    bytes[i] = (i * 7 + (i >> 12)) & 0xff;
  }
  return { bytes, blob: new Blob([ bytes ]) };
}

const uploaded = () => vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

test("a file larger than a chunk goes up as numbered chunks that add up to it", async () => {
  window.fetch = uploaded();
  const { bytes, blob } = fileOf(2 * CHUNK + 12345);

  await expect(uploadFile(destination, blob, "GVS_2025-manual", "stream", noRetries)).resolves.toBeUndefined();

  const chunks = await sentChunks();

  expect(chunks.map(c => c.index)).toStrictEqual([ 0, 1, 2 ]);
  expect(chunks.map(c => c.bytes.length)).toStrictEqual([ CHUNK, CHUNK, 12345 ]);
  expect(chunks.every(c =>
    `${c.origin}/` === API && c.method === "PUT" && c.recording === "GVS_2025-manual" && c.track === "stream"
  )).toBe(true);

  const joined = new Uint8Array(bytes.length);
  let offset = 0;
  for(const c of chunks) {
    joined.set(c.bytes, offset);
    offset += c.bytes.length;
  }
  // the first byte that differs rather than toStrictEqual, whose element-wise deep
  // comparison of a 9 MiB array takes longer than the test is allowed to run
  expect(joined.findIndex((byte, i) => byte !== bytes[i])).toBe(-1);
});

test("a file of exactly whole chunks gets no empty chunk at the end", async () => {
  window.fetch = uploaded();

  await uploadFile(destination, fileOf(2 * CHUNK).blob, "GVS_2025-manual", "stream", noRetries);

  expect((await sentChunks()).map(c => c.bytes.length)).toStrictEqual([ CHUNK, CHUNK ]);
});

test("a file smaller than a chunk goes up as chunk 0", async () => {
  window.fetch = uploaded();

  await uploadFile(destination, fileOf(1000).blob, "GVS_2025-manual", "overlay", noRetries);

  expect((await sentChunks()).map(c => [ c.index, c.bytes.length ])).toStrictEqual([ [ 0, 1000 ] ]);
});

test("the names of a file's recording and track are percent-encoded into the chunk path", async () => {
  window.fetch = uploaded();

  await uploadFile(destination, fileOf(1000).blob, "Übung_2025-manual", "audio/0", noRetries);

  expect((await sentChunks()).map(c => c.url))
    .toStrictEqual([ chunkUrl(encodeURIComponent("Übung_2025-manual"), encodeURIComponent("audio/0"), 0) ]);
});

test("an empty file sends nothing and counts as uploaded", async () => {
  window.fetch = vi.fn();

  await expect(uploadFile(destination, new Blob([]), "GVS_2025-manual", "audio-0", noRetries)).resolves.toBeUndefined();

  expect(window.fetch).not.toHaveBeenCalled();
});

test("the upload stops at the first chunk that fails", async () => {
  // the rest would only land behind a gap, which the backend treats as the end of the track
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => new Response(null, { status: 204 }))
    .mockImplementation(async () => Response.json({ detail: "disk full" }, { status: 507 }));

  const error = await rejectionOf(uploadFile(destination, fileOf(3 * CHUNK).blob, "GVS_2025-manual", "stream", noRetries));

  expect(error).toBeInstanceOf(ApiError);
  // the server's explanation travels with the error, for the caller to show
  expect((error as ApiError).detail).toBe("disk full");
  expect((await sentChunks()).map(c => c.index)).toStrictEqual([ 0, 1 ]);
});

test("progress is signalled with the size of every chunk that arrived", async () => {
  window.fetch = uploaded();
  const signalProgress = vi.fn();

  await uploadFile(destination, fileOf(2 * CHUNK + 12345).blob, "GVS_2025-manual", "stream", noRetries, signalProgress);

  // byte counts rather than a percentage: the caller adds them up across tracks
  expect(signalProgress.mock.calls).toStrictEqual([ [ CHUNK ], [ CHUNK ], [ 12345 ] ]);
});

test("a chunk that failed is not counted as progress", async () => {
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => new Response(null, { status: 204 }))
    .mockImplementation(async () => Response.json({ detail: "disk full" }, { status: 507 }));
  const signalProgress = vi.fn();

  await rejectionOf(uploadFile(destination, fileOf(3 * CHUNK).blob, "GVS_2025-manual", "stream", noRetries, signalProgress));

  expect(signalProgress.mock.calls).toStrictEqual([ [ CHUNK ] ]);
});

test("a chunk is retried by the file's retry policy", async () => {
  useRetryClock();

  window.fetch = vi.fn()
    .mockImplementationOnce(async () => Response.json("", { status: 503 }))
    .mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    })
    .mockImplementation(async () => new Response(null, { status: 204 }));

  const before = Date.now();
  await expect(settleRetries(uploadFile(destination, fileOf(1000).blob, "GVS_2025-manual", "stream", retrying({ retries: 2, initialWaitMillis: 50 }))))
    .resolves.toBeUndefined();

  // the same chunk three times, backing off 50 + 100
  expect((await sentChunks()).map(c => c.index)).toStrictEqual([ 0, 0, 0 ]);
  expect(Date.now() - before).toBe(150);
});

test("retries of a chunk are not counted twice", async () => {
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => Response.json({}, { status: 503 }))
    .mockImplementation(async () => new Response(null, { status: 204 }));
  const signalProgress = vi.fn();

  await expect(uploadFile(destination, fileOf(1000).blob, "GVS_2025-manual", "stream", retrying({ retries: 1, initialWaitMillis: 0 }), signalProgress)).resolves.toBeUndefined();

  expect(window.fetch).toHaveBeenCalledTimes(2);
  expect(signalProgress.mock.calls).toStrictEqual([ [ 1000 ] ]);
});

test("an aborted upload of a file stops at the chunk it was on", async () => {
  const controller = new AbortController();
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => {
      controller.abort("chunk");
      return new Response(null, { status: 204 });
    })
    .mockImplementation(async () => new Response(null, { status: 204 }));

  const error = await rejectionOf(uploadFile(destination, fileOf(3 * CHUNK).blob, "GVS_2025-manual", "stream", { ...noRetries, abortSignal: controller.signal }));

  expect(error).toBe("chunk");
  expect(window.fetch).toHaveBeenCalledOnce();
});
