import { afterEach, expect, test, vi } from "vitest";
import { ApiDestination, ApiError, apiFetchData, apiFetchVoid, defaultRetryPolicy, RetryPolicy, withRetries } from "@/lib/utils/apiFetch";
import * as z from "zod";

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
});

// --- the request -------------------------------------------------------------

test("a request goes to its path below the api url", async () => {
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid(destination, "api/recordings/FOO", { method: "DELETE" });

  // one Request and nothing besides, so everything about it is on the Request
  expect(window.fetch).toHaveBeenCalledOnce();
  expect(vi.mocked(window.fetch).mock.calls[0]).toHaveLength(1);
  expect(fetchedRequest().url).toBe(`${API}api/recordings/FOO`);
  expect(fetchedRequest().method).toBe("DELETE");
});

test("a request below an api url with a path prefix keeps the prefix", async () => {
  // a backend behind a reverse proxy, under a path of its own
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid({ ...destination, apiUrl: "https://example.com/ise/" }, "api/recordings", undefined);

  expect(fetchedRequest().url).toBe("https://example.com/ise/api/recordings");
});

test("a request carries the access token as a bearer token", async () => {
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid(destination, "api/recordings", undefined);

  expect(fetchedRequest().headers.get("Authorization")).toBe("Bearer test-token");
});

test("a request is unauthenticated if no access token is available", async () => {
  // an anonymous backend deployment has no token, and the backend decides whether it minds
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid({ ...destination, getAccessToken: noAccessToken }, "api/recordings", undefined);

  expect(fetchedRequest().headers.has("Authorization")).toBe(false);
});

test("the access token is added to the request's own headers rather than replacing them", async () => {
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid(destination, "api/recordings/FOO/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: "lecturer@example.com" })
  });

  expect(fetchedRequest().headers.get("Content-Type")).toBe("application/json");
  expect(fetchedRequest().headers.get("Authorization")).toBe("Bearer test-token");
  expect(await fetchedRequest().json()).toStrictEqual({ recipient: "lecturer@example.com" });
});

// --- the response ------------------------------------------------------------

const Recording = z.object({ state: z.literal("rendering"), name: z.string() });

test("a response is parsed by the schema it is fetched with", async () => {
  window.fetch = vi.fn().mockImplementation(async () => Response.json({ state: "rendering", name: "FOO" }, { status: 202 }));

  await expect(apiFetchData(destination, "api/recordings/FOO/render", { method: "POST" }, Recording))
    .resolves.toStrictEqual({ state: "rendering", name: "FOO" });
});

test("a response that does not match the schema is an invalid response, not a result", async () => {
  // a backend from before the API was reshaped answers like this
  window.fetch = vi.fn().mockImplementation(async () => Response.json({ recording: "FOO" }, { status: 202 }));

  const error = await rejectionOf(apiFetchData(destination, "api/recordings/FOO/render", { method: "POST" }, Recording));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("invalid-response");
  expect((error as ApiError).status).toBe(202);
  // the ZodError is kept: it is how the processed recordings section recognises a backend
  // that speaks a different version of the API
  expect((error as ApiError).cause).toBeInstanceOf(z.ZodError);
  // the backend answered, but asking again gets the same answer
  expect((error as ApiError).transient).toBe(false);
});

test("a response that is not JSON at all is an invalid response", async () => {
  // what a misconfigured apiUrl pointing at the frontend itself answers with
  window.fetch = vi.fn().mockImplementation(async () => new Response("<html>ISE Recorder</html>", { status: 200 }));

  const error = await rejectionOf(apiFetchData(destination, "api/recordings", undefined, z.array(Recording)));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("invalid-response");
  expect((error as ApiError).cause).toBeInstanceOf(SyntaxError);
});

test("a response to a void request is not read", async () => {
  // a 204 has no body, and one that has a body anyway is none of the caller's business
  window.fetch = vi.fn().mockImplementation(async () => new Response("not json", { status: 200 }));

  await expect(apiFetchVoid(destination, "api/recordings/FOO", { method: "DELETE" })).resolves.toBeUndefined();
});

// --- errors ------------------------------------------------------------------

test("a refusal carries the status and the server's explanation", async () => {
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Recording FOO does not exist" }, { status: 404 }));

  const error = await rejectionOf(apiFetchVoid(destination, "api/recordings/FOO/render", { method: "POST" }));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("http");
  expect((error as ApiError).status).toBe(404);
  expect((error as ApiError).detail).toBe("Recording FOO does not exist");
  expect((error as ApiError).message).toBe("HTTP 404: Recording FOO does not exist");
});

test("a refusal whose detail is not a string is not stringified", async () => {
  // FastAPI answers a validation failure with an array of issue objects
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: [ { loc: [ "path", "recording" ], msg: "String should match pattern" } ] }, { status: 422 }));

  const error = await rejectionOf(apiFetchVoid(destination, "api/recordings/FOO", { method: "DELETE" }));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(422);
  expect((error as ApiError).detail).toBeUndefined();
  expect((error as ApiError).message).toBe("HTTP 422");
  expect((error as ApiError).message).not.toContain("[object Object]");
});

test("a refusal that is not JSON still says something", async () => {
  window.fetch = vi.fn().mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));

  const error = await rejectionOf(apiFetchVoid(destination, "api/recordings", undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toBe("HTTP 502");
  // a gateway's error page is not something to put in a toast
  expect((error as ApiError).message).not.toContain("<html>");
  expect((error as ApiError).detail).toBeUndefined();
});

test("a refusal of a data request is a refusal, not an invalid response", async () => {
  // the error body is checked before the schema is, so the server's explanation survives
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Authentication not configured" }, { status: 403 }));

  const error = await rejectionOf(apiFetchData(destination, "api/recordings", undefined, z.array(Recording)));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("http");
  expect((error as ApiError).detail).toBe("Authentication not configured");
});

test("a backend that cannot be reached is a network error with fetch's own error as its cause", async () => {
  // what fetch() said is the only clue to which of the many ways of not arriving it was
  const unreachable = new TypeError("NetworkError when attempting to fetch resource.");
  window.fetch = vi.fn().mockRejectedValue(unreachable);

  const error = await rejectionOf(apiFetchVoid(destination, "api/recordings", undefined));

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).kind).toBe("network");
  expect((error as ApiError).status).toBeUndefined();
  expect((error as ApiError).cause).toBe(unreachable);
  expect((error as ApiError).message).toContain(unreachable.message);
});

// --- which failures are worth retrying ------------------------------------

/**
 * Retrying is deliberately aggressive: losing a lecture chunk is worse than hammering a
 * backend that only ever serves one lecture at a time. But a response that says the
 * request itself is wrong will say the same thing ten times, and the whole retry budget
 * is spent before the user is told anything. Worse, the budget is spent *per chunk*, so
 * a misconfigured apiUrl turns every five-second timeslice into twenty seconds of
 * pointless traffic for the length of the lecture.
 */

test.each([ 401, 408, 429, 500, 502, 503, 504, 507 ])("a refusal with %i is transient", status => {
  // 401 among them: it is plausibly an auth server brownout, and the retry window gives the
  // token time to be renewed. 403 is not -- the backend only answers it when it is
  // configured without auth, which waiting will not change.
  expect(new ApiError(`HTTP ${status}`, "http", status).transient).toBe(true);
});

test.each([ 400, 403, 404, 409, 422 ])("a refusal with %i is not transient", status => {
  expect(new ApiError(`HTTP ${status}`, "http", status).transient).toBe(false);
});

test("a network error is transient, since it says nothing about the request", () => {
  expect(new ApiError("Network error: Failed to fetch", "network").transient).toBe(true);
});

const brokenServerResponding = (status: number) => {
  const requests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      requests.push(request);
      return Response.json("", { status });
    });

  return requests;
};

const callBrokenServer = (retryPolicy: RetryPolicy) =>
  withRetries(() => apiFetchVoid(destination, "api/recordings/FOO/tracks/stream/chunks/42", { method: "PUT", body: "chunk" }), retryPolicy);

test("a call to a flaky server is retried until it goes through", async () => {
  useRetryClock();

  const requests: Request[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      requests.push(request);
      return Response.json({ state: "rendering", name: "FOO" }, { status: 202 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      // how fetch() reports a request that never got an answer
      requests.push(request);
      throw new TypeError("Failed to fetch");
    });

  const pending = withRetries(
    () => apiFetchData(destination, "api/recordings/FOO/render", { method: "POST", body: "{}" }, Recording),
    retrying({ retries: 10, initialWaitMillis: 50 })
  );

  await expect(settleRetries(pending)).resolves.toStrictEqual({ state: "rendering", name: "FOO" });

  expect(requests.length).toBe(2);

  // the same request again, body and all
  for(const req of requests) {
    expect(req.url).toBe(`${API}api/recordings/FOO/render`);
    expect(req.method).toBe("POST");
    expect(await req.text()).toBe("{}");
  }
});

test("a call to a broken server gives up after the configured retries", async () => {
  useRetryClock();

  const requests = brokenServerResponding(503);

  const before = Date.now();
  const error = await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50 }))));
  const elapsed = Date.now() - before;

  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(503);

  // one attempt and three retries, backing off 50 + 100 + 200
  expect(requests.length).toBe(4);
  expect(elapsed).toBe(350);
});

test("a call without retries gives up after one attempt", async () => {
  useRetryClock();

  brokenServerResponding(503);

  const before = Date.now();
  await expect(settleRetries(callBrokenServer(retrying({ retries: 0, initialWaitMillis: 5000 })))).rejects.toBeInstanceOf(ApiError);

  expect(window.fetch).toHaveBeenCalledOnce();
  // no backoff before giving up, or the rerender button would stay disabled for nothing
  expect(Date.now() - before).toBe(0);
});

test("the default policy does not retry", async () => {
  // retrying is the caller's decision, made for what it is doing: a live recording can
  // afford to wait for minutes, a press of a button cannot
  useRetryClock();

  brokenServerResponding(503);

  await expect(settleRetries(callBrokenServer(defaultRetryPolicy))).rejects.toBeInstanceOf(ApiError);

  expect(window.fetch).toHaveBeenCalledOnce();
});

test.each([ 400, 403, 404, 409, 422 ])("a call refused with %i is not retried", async status => {
  useRetryClock();

  const requests = brokenServerResponding(status);

  const error = await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50 }))));

  // one attempt, no backoff: the server has said the request is malformed, and it will
  // still be malformed in fifty milliseconds
  expect(requests.length).toBe(1);
  expect((error as ApiError).status).toBe(status);
});

test.each([ 401, 408, 429, 500, 502, 503 ])("a call refused with %i is retried", async status => {
  useRetryClock();

  const requests = brokenServerResponding(status);
  const before = Date.now();

  await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50 }))));

  expect(requests.length).toBe(4);
  expect(Date.now() - before).toBe(350);
});

test("a network failure is retried, since it says nothing about the request", async () => {
  useRetryClock();

  const attempts: number[] = [];

  window.fetch = vi.fn().mockImplementation(async () => {
    attempts.push(Date.now());
    throw new TypeError("Failed to fetch");
  });

  const error = await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50 }))));

  expect(attempts.length).toBe(4);
  expect((error as ApiError).kind).toBe("network");
});

test("an invalid response is not retried", async () => {
  // the backend answered, and it will answer the same again
  useRetryClock();

  window.fetch = vi.fn().mockImplementation(async () => Response.json({ recording: "FOO" }, { status: 202 }));

  const error = await settleRetries(rejectionOf(withRetries(
    () => apiFetchData(destination, "api/recordings/FOO/render", { method: "POST" }, Recording),
    retrying({ retries: 3, initialWaitMillis: 50 })
  )));

  expect(window.fetch).toHaveBeenCalledOnce();
  expect((error as ApiError).kind).toBe("invalid-response");
});

test("an error that is not an ApiError is not retried", async () => {
  // a bug on our side, which no amount of waiting fixes
  useRetryClock();

  const bug = new RangeError("index out of range");
  const attempt = vi.fn().mockRejectedValue(bug);

  await expect(settleRetries(withRetries(attempt, retrying({ retries: 3, initialWaitMillis: 50 })))).rejects.toBe(bug);

  expect(attempt).toHaveBeenCalledOnce();
});

test("a permanent failure still reports the server's explanation", async () => {
  useRetryClock();

  window.fetch = vi.fn()
    .mockImplementation(async () => Response.json({ detail: "recording name is not acceptable" }, { status: 422 }));

  const error = await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50 }))));

  // giving up early must not cost the diagnosis: without the body the user sees a bare
  // status code for a mistake only the message explains
  expect((error as ApiError).message).toContain("recording name is not acceptable");
  expect((error as ApiError).detail).toBe("recording name is not acceptable");
});

test("the error a call gives up with is the one from its last attempt", async () => {
  useRetryClock();

  window.fetch = vi.fn()
    .mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    })
    .mockImplementationOnce(async () => Response.json({ detail: "rebooting" }, { status: 503 }))
    .mockImplementation(async () => Response.json({ detail: "disk full" }, { status: 507 }));

  const error = await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 2, initialWaitMillis: 50 }))));

  expect((error as ApiError).status).toBe(507);
  expect((error as ApiError).detail).toBe("disk full");
});

test("every attempt asks for a fresh access token", async () => {
  useRetryClock();

  const requests: Request[] = [];

  // A recording outlives its access token, so a retry must not reuse the token that
  // was current when the first attempt failed -- least of all when the failure was the
  // backend turning that token away.
  let issuedTokens = 0;
  const rotatingAccessToken = async () => `test-token-${++issuedTokens}`;

  window.fetch = vi.fn()
    .mockImplementation(async (request: Request): Promise<Response> => {
      requests.push(request);
      return new Response(null, { status: 204 });
    })
    .mockImplementationOnce(async (request: Request): Promise<Response> => {
      requests.push(request);
      return Response.json({ detail: "Not authenticated" }, { status: 401 });
    });

  await settleRetries(withRetries(
    () => apiFetchVoid({ apiUrl: API, getAccessToken: rotatingAccessToken }, "api/recordings/FOO/tracks/stream/chunks/42", { method: "PUT", body: "chunk" }),
    retrying({ retries: 10, initialWaitMillis: 50 })
  ));

  expect(requests.length).toBe(2);
  expect(requests[0].headers.get("Authorization")).toBe("Bearer test-token-1");
  expect(requests[1].headers.get("Authorization")).toBe("Bearer test-token-2");
});

// --- backing off -------------------------------------------------------------
//
// Running out of retries costs the lecturer a full re-upload, so the budget has to stretch
// across something like a backend restart without hammering the backend while it is down.

/** Answer every request with 503 and record when each one arrived, on the fake clock. */
const unavailableServerAttemptTimes = () => {
  const times: number[] = [];

  window.fetch = vi.fn().mockImplementation(async () => {
    times.push(Date.now());
    return Response.json("", { status: 503 });
  });

  return times;
};

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

test("the wait between retries doubles by default", async () => {
  useRetryClock();
  const times = unavailableServerAttemptTimes();

  await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 4, initialWaitMillis: 50 }))));

  expect(gaps(times)).toStrictEqual([ 50, 100, 200, 400 ]);
});

test("the wait between retries grows by the configured factor", async () => {
  useRetryClock();
  const times = unavailableServerAttemptTimes();

  await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 3, initialWaitMillis: 50, backoffFactor: 3 }))));

  expect(gaps(times)).toStrictEqual([ 50, 150, 450 ]);
});

test("the wait between retries stops growing at the configured maximum", async () => {
  useRetryClock();
  const times = unavailableServerAttemptTimes();

  await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 5, initialWaitMillis: 50, maxWaitMillis: 120 }))));

  expect(gaps(times)).toStrictEqual([ 50, 100, 120, 120, 120 ]);
});

test("the wait between retries stops growing at a minute by default", async () => {
  // the budget a live recording runs on: nine retries from two seconds is about five minutes
  useRetryClock();
  const times = unavailableServerAttemptTimes();

  await settleRetries(rejectionOf(callBrokenServer(retrying({ retries: 9, initialWaitMillis: 2000 }))));

  expect(gaps(times)).toStrictEqual([ 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000 ]);
});

// --- aborting ----------------------------------------------------------------
//
// A live recording shares one AbortSignal across all its uploads. Once one chunk has given
// up, the recording has a hole on the server and needs re-uploading anyway, so every other
// upload stops at once instead of retrying for minutes and reporting its own failure.

/**
 * A fetch that never answers but, like the real one, rejects with the signal's reason once
 * the signal of the request it was given is aborted. Resolves `started` when the request
 * has gone out.
 */
function hangingFetch() {
  let markStarted: () => void = () => {};
  const started = new Promise<void>(resolve => markStarted = resolve);

  window.fetch = vi.fn().mockImplementation((request: Request) =>
    new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      markStarted();
    }));

  return started;
}

const callBrokenServerUntil = (abortSignal: AbortSignal, retryPolicy: Partial<RetryPolicy>) =>
  withRetries(
    () => apiFetchVoid(destination, "api/recordings/FOO/tracks/stream/chunks/0", { method: "PUT", body: "chunk", signal: abortSignal }),
    retrying({ ...retryPolicy, abortSignal })
  );

test("an abort during the wait before a retry ends the call at once", async () => {
  useRetryClock();
  const times = unavailableServerAttemptTimes();
  const controller = new AbortController();

  const before = Date.now();
  const pending = callBrokenServerUntil(controller.signal, { retries: 3, initialWaitMillis: 50 });
  const rejection = rejectionOf(pending);

  // let the first attempt land, so the call is now waiting to retry. Not vi.waitFor():
  // under a fake clock it advances the clock itself, which would fire the very backoff
  // this test needs to catch still waiting.
  while(times.length === 0) {
    await new Promise(resolve => realSetTimeout(resolve, 0));
  }
  await new Promise(resolve => realSetTimeout(resolve, 0));

  controller.abort("chunk");

  // no timer is advanced from here on: if the abort did not end the wait, this never settles.
  // It ends with the abort's reason rather than the 503 it was waiting out, so the caller
  // can tell it apart from a failure.
  expect(await rejection).toBe("chunk");
  expect(times.length).toBe(1);
  expect(Date.now() - before).toBe(0);
});

test("an abort while a request is in flight ends the call without another attempt", async () => {
  // The request that is out when another chunk gives up. A fetch rejected by the abort
  // must not read as a network failure, or it would sit out its whole retry budget with
  // every later attempt rejected on the spot, and then report a failure of its own.
  useRetryClock();
  const started = hangingFetch();
  const controller = new AbortController();

  const before = Date.now();
  const rejection = rejectionOf(callBrokenServerUntil(controller.signal, { retries: 3, initialWaitMillis: 50 }));

  await started;
  controller.abort("chunk");

  expect(await rejection).toBe("chunk");
  expect(window.fetch).toHaveBeenCalledOnce();
  expect(Date.now() - before).toBe(0);
});

test("an abort during the last attempt is not reported as a failure", async () => {
  // No retry wait follows the last attempt to notice the abort, so the request itself has to
  // tell it apart from a network error. Otherwise the chunks of the other tracks, which run
  // on the same schedule as the one that gave up, report failures of their own.
  const started = hangingFetch();
  const controller = new AbortController();

  const rejection = rejectionOf(callBrokenServerUntil(controller.signal, noRetries));

  await started;
  controller.abort("chunk");

  const error = await rejection;
  expect(error).toBe("chunk");
  expect(error).not.toBeInstanceOf(ApiError);
});

test("an aborted request that fetch rejects with a TypeError is not a network error", async () => {
  // what the abort is rejected with is fetch's business; that the request was aborted is
  // what tells it apart from a network failure
  const controller = new AbortController();
  window.fetch = vi.fn().mockImplementation(async () => {
    controller.abort("chunk");
    throw new TypeError("Failed to fetch");
  });

  const error = await rejectionOf(apiFetchVoid(destination, "api/recordings", { signal: controller.signal }));

  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(ApiError);
});

test("an abort while the response is read is not an invalid response", async () => {
  // a listing that is still arriving when the lecturer navigates away
  const controller = new AbortController();

  window.fetch = vi.fn().mockImplementation(async (request: Request) => {
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("[{\"state\":"));
        request.signal.addEventListener("abort", () => stream.error(request.signal.reason), { once: true });
      }
    });
    return new Response(body, { status: 200 });
  });

  const rejection = rejectionOf(apiFetchData(destination, "api/recordings", { signal: controller.signal }, z.array(Recording)));

  await vi.waitFor(() => expect(window.fetch).toHaveBeenCalledOnce());
  controller.abort("navigated away");

  // what reading an aborted body rejects with differs between browsers -- Chromium says
  // TypeError, not the abort's reason -- but it is no verdict on the backend either way
  await expect(rejection).resolves.not.toBeInstanceOf(ApiError);
});

test("an abort before a retry wait has begun ends the call at once", async () => {
  // the abort came while the attempt was failing for a reason of its own
  useRetryClock();
  const controller = new AbortController();

  window.fetch = vi.fn().mockImplementation(async () => {
    controller.abort("chunk");
    return Response.json("", { status: 503 });
  });

  const before = Date.now();
  const error = await rejectionOf(callBrokenServerUntil(controller.signal, { retries: 3, initialWaitMillis: 50 }));

  expect(error).toBe("chunk");
  expect(window.fetch).toHaveBeenCalledOnce();
  expect(Date.now() - before).toBe(0);
});

test.each([
  [ "with", accessToken ],
  [ "without", noAccessToken ]
])("the abort signal reaches the request %s an access token", async (_, getAccessToken) => {
  // an anonymous backend deployment has no token, and its requests must be cancellable too
  const controller = new AbortController();
  window.fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));

  await apiFetchVoid({ apiUrl: API, getAccessToken }, "api/recordings", { signal: controller.signal });

  // the Request follows the signal it was built with rather than being that signal
  const request = fetchedRequest();
  expect(request.signal.aborted).toBe(false);
  controller.abort("chunk");
  expect(request.signal.aborted).toBe(true);
  expect(request.signal.reason).toBe("chunk");
});
