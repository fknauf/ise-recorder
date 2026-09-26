import { afterEach, expect, test, vi } from "vitest";
import { downloadUrl, purgeRecording, sendChunkToServer, schedulePostprocessing, ServerStorageDestination, uploadFile } from "@/lib/utils/serverStorage";
import { showError, showSuccess } from "@/lib/utils/notifications";

interface FetchRequest {
  url: string | URL | Request
  data?: RequestInit
}

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

  for(let guard = 0; !settled && guard < 100; ++guard) {
    await new Promise(resolve => realSetTimeout(resolve, 0));
    await vi.runAllTimersAsync();
  }

  return tracked;
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(showError).mockClear();
  vi.mocked(showSuccess).mockClear();
});

test("sending chunk to server is nop if api url is undefined", async () => {
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  window.fetch = vi.fn();

  const destination: ServerStorageDestination = {
    apiUrl: undefined,
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 0);
  expect(window.fetch).not.toHaveBeenCalled();
});

test("sending chunk to server", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });

  let fetchRequest: FetchRequest = {
    url: ""
  };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequest = {
        url, data
      };

      return Response.json("");
    });

  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42);


  expect(fetchRequest.url).toBe(`${destination.apiUrl}/api/chunks`);
  expect(fetchRequest.data?.method).toBe("POST");
  expect(fetchRequest.data?.headers).toStrictEqual({ Authorization: "Bearer test-token" });
  expect(fetchRequest.data?.body).toBeInstanceOf(FormData);

  const requestBody = fetchRequest.data?.body as FormData;

  expect(requestBody.get("recording")).toStrictEqual("FOO");
  expect(requestBody.get("track")).toStrictEqual("stream.webm");
  expect(requestBody.get("index")).toStrictEqual("42");
  expect(await (requestBody.get("chunk") as File).text()).toStrictEqual(await chunk.text());
});

test("sending chunk to flaky server", async () => {
  useRetryClock();

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("");
    })
    .mockImplementationOnce(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.error();
    });

  const pending = sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 10, intervalMillis: 50 });

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${destination.apiUrl}/api/chunks`);
    expect(req.data?.method).toBe("POST");
    expect(req.data?.body).toBeInstanceOf(FormData);

    const requestBody = req.data?.body as FormData;

    expect(requestBody.get("recording")).toStrictEqual("FOO");
    expect(requestBody.get("track")).toStrictEqual("stream.webm");
    expect(requestBody.get("index")).toStrictEqual("42");
    expect(await (requestBody.get("chunk") as File).text()).toStrictEqual(await chunk.text());
  }
});

test("sending chunk to broken server", async () => {
  useRetryClock();

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("", { status: 503 });
    });

  const before = Date.now();
  const pending = sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 });

  await settleRetries(pending);

  const elapsed = Date.now() - before;

  expect(vi.mocked(showError)).toHaveBeenCalled();

  expect(fetchRequests.length).toBe(4);
  expect(elapsed).toBe(150);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${destination.apiUrl}/api/chunks`);
    expect(req.data?.method).toBe("POST");
    expect(req.data?.body).toBeInstanceOf(FormData);

    const requestBody = req.data?.body as FormData;

    expect(requestBody.get("recording")).toStrictEqual("FOO");
    expect(requestBody.get("track")).toStrictEqual("stream.webm");
    expect(requestBody.get("index")).toStrictEqual("42");
    expect(await (requestBody.get("chunk") as File).text()).toStrictEqual(await chunk.text());
  }
});

test("schedule postprocessing is nop if api url is undefined", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: undefined,
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  window.fetch = vi.fn();
  await schedulePostprocessing(destination, "FOO", "lecturer@example.com");
  expect(window.fetch).not.toHaveBeenCalled();
});

test("schedule postprocessing", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  let fetchRequest: FetchRequest = { url: "" };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequest = { url, data };
      return Response.json("");
    });

  await schedulePostprocessing(destination, "FOO", "lecturer@example.com");

  expect(fetchRequest.url).toBe(`${destination.apiUrl}/api/jobs`);
  expect(fetchRequest.data?.method).toBe("POST");
  expect(fetchRequest.data?.headers).toStrictEqual({
    "Content-Type": "application/json",
    "Authorization": "Bearer test-token"
  });

  const requestBody = JSON.parse(fetchRequest.data?.body as string);
  expect(requestBody).toStrictEqual({ recording: "FOO", recipient: "lecturer@example.com" });

  // the confirmation is the only sign the lecturer gets that postprocessing was accepted
  expect(vi.mocked(showSuccess)).toHaveBeenCalledWith(expect.stringContaining("FOO"));
  expect(vi.mocked(showError)).not.toHaveBeenCalled();
});

test("schedule postprocessing to flaky server", async () => {
  useRetryClock();

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  const fetchRequests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("");
    })
    .mockImplementationOnce(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("", { status: 503 });
    });

  const pending = schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 5, intervalMillis: 50 });

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${destination.apiUrl}/api/jobs`);
    expect(req.data?.method).toBe("POST");
    expect(req.data?.headers).toStrictEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer test-token"
    });

    const requestBody = JSON.parse(req.data?.body as string);
    expect(requestBody).toStrictEqual({ recording: "FOO", recipient: "lecturer@example.com" });
  }
});

test("schedule postprocessing to broken server", async () => {
  useRetryClock();

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  const fetchRequests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.error();
    });

  const before = Date.now();
  const pending = schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 3, intervalMillis: 50 });

  await settleRetries(pending);

  const elapsed = Date.now() - before;

  expect(fetchRequests.length).toBe(4);
  expect(elapsed).toBe(150);
  expect(vi.mocked(showError)).toHaveBeenCalled();

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${destination.apiUrl}/api/jobs`);
    expect(req.data?.method).toBe("POST");
    expect(req.data?.headers).toStrictEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer test-token"
    });

    const requestBody = JSON.parse(req.data?.body as string);
    expect(requestBody).toStrictEqual({ recording: "FOO", recipient: "lecturer@example.com" });
  }
});

// The rerender button refreshes the listing only when the job was accepted, so the result
// is part of the contract now rather than only the notification.

test("schedule postprocessing reports an accepted job", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  window.fetch = vi.fn().mockImplementation(async () => Response.json("", { status: 202 }));

  await expect(schedulePostprocessing(destination, "FOO", "lecturer@example.com")).resolves.toBe(true);
});

test("schedule postprocessing reports a refused job", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  // what the backend answers for a recording that does not exist
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Recording FOO does not exist" }, { status: 400 }));

  await expect(schedulePostprocessing(destination, "FOO", "lecturer@example.com")).resolves.toBe(false);
  expect(vi.mocked(showError)).toHaveBeenCalled();
});

test("schedule postprocessing without retries gives up after one attempt", async () => {
  useRetryClock();

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  window.fetch = vi.fn().mockImplementation(async () => Response.json("", { status: 503 }));

  const before = Date.now();
  const scheduled = await settleRetries(
    schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 0, intervalMillis: 5000 })
  );

  expect(scheduled).toBe(false);
  expect(window.fetch).toHaveBeenCalledOnce();
  // no backoff before giving up, or the rerender button would stay disabled for nothing
  expect(Date.now() - before).toBe(0);
});

test("schedule postprocessing without a backend reports nothing scheduled", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: undefined,
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  window.fetch = vi.fn();

  await expect(schedulePostprocessing(destination, "FOO", "lecturer@example.com")).resolves.toBeFalsy();
});

test("schedule postprocessing after impeded streaming reports nothing scheduled", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: true,
    getAccessToken: accessToken
  };

  window.fetch = vi.fn();

  await expect(schedulePostprocessing(destination, "FOO", "lecturer@example.com")).resolves.toBeFalsy();
  expect(window.fetch).not.toHaveBeenCalled();
});

test("chunk upload is unauthenticated if no access token is available", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: noAccessToken
  };
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });

  let fetchRequest: FetchRequest = { url: "" };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequest = { url, data };
      return Response.json("");
    });

  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42);

  // The chunk request carries no headers of its own, so an unauthenticated upload has none.
  expect(fetchRequest.data?.headers).toBeUndefined();
});

test("postprocessing request is unauthenticated if no access token is available", async () => {
  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: noAccessToken
  };

  let fetchRequest: FetchRequest = { url: "" };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequest = { url, data };
      return Response.json("");
    });

  await schedulePostprocessing(destination, "FOO", "lecturer@example.com");

  expect(fetchRequest.data?.headers).toStrictEqual({ "Content-Type": "application/json" });
});

test("chunk upload requests a fresh access token for every attempt", async () => {
  useRetryClock();

  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: FetchRequest[] = [];

  // A recording outlives its access token, so a retry must not reuse the token that
  // was current when the first attempt failed.
  let issuedTokens = 0;
  const rotatingAccessToken = async () => `test-token-${++issuedTokens}`;

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: rotatingAccessToken
  };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("");
    })
    .mockImplementationOnce(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("", { status: 401 });
    });

  const pending = sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 10, intervalMillis: 50 });

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);
  expect(fetchRequests[0].data?.headers).toStrictEqual({ Authorization: "Bearer test-token-1" });
  expect(fetchRequests[1].data?.headers).toStrictEqual({ Authorization: "Bearer test-token-2" });
});

test("postprocessing request requests a fresh access token for every attempt", async () => {
  useRetryClock();

  const fetchRequests: FetchRequest[] = [];

  let issuedTokens = 0;
  const rotatingAccessToken = async () => `test-token-${++issuedTokens}`;

  const destination: ServerStorageDestination = {
    apiUrl: "http://record.example.com",
    streamingImpeded: false,
    getAccessToken: rotatingAccessToken
  };

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("");
    })
    .mockImplementationOnce(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("", { status: 401 });
    });

  const pending = schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 5, intervalMillis: 50 });

  await settleRetries(pending);

  expect(fetchRequests.length).toBe(2);
  expect(fetchRequests[0].data?.headers).toStrictEqual({
    "Content-Type": "application/json",
    "Authorization": "Bearer test-token-1"
  });
  expect(fetchRequests[1].data?.headers).toStrictEqual({
    "Content-Type": "application/json",
    "Authorization": "Bearer test-token-2"
  });
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

const brokenServerResponding = (status: number) => {
  const requests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      requests.push({ url, data });
      return Response.json("", { status });
    });

  return requests;
};

const brokenDestination: ServerStorageDestination = {
  apiUrl: "http://record.example.com",
  streamingImpeded: false,
  getAccessToken: accessToken
};

const chunkOf = () => new Blob([ "Hello, world." ], { type: "text/plain" });

test.each([ 400, 404, 422 ])("a chunk rejected with %i is not retried", async status => {
  useRetryClock();

  const requests = brokenServerResponding(status);

  await settleRetries(
    sendChunkToServer(brokenDestination, chunkOf(), "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 })
  );

  // one attempt, no backoff: the server has said the request is malformed, and it will
  // still be malformed in fifty milliseconds
  expect(requests.length).toBe(1);
  expect(vi.mocked(showError)).toHaveBeenCalled();
});

test.each([ 401, 403, 500, 502, 503 ])("a chunk rejected with %i is retried", async status => {
  useRetryClock();

  const requests = brokenServerResponding(status);
  const before = Date.now();

  await settleRetries(
    sendChunkToServer(brokenDestination, chunkOf(), "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 })
  );

  // 401 in particular has to stay retryable: it is plausibly an auth server restart, and
  // the retry window gives the token time to be renewed
  expect(requests.length).toBe(4);
  expect(Date.now() - before).toBe(150);
});

test("a network failure is retried, since it says nothing about the request", async () => {
  useRetryClock();

  const attempts: number[] = [];

  window.fetch = vi.fn().mockImplementation(async () => {
    attempts.push(Date.now());
    throw new TypeError("Failed to fetch");
  });

  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    await settleRetries(
      sendChunkToServer(brokenDestination, chunkOf(), "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 })
    );

    expect(attempts.length).toBe(4);
  } finally {
    consoleWarn.mockRestore();
  }
});

test.each([ 400, 404, 422 ])("postprocessing rejected with %i is not retried", async status => {
  useRetryClock();

  const requests = brokenServerResponding(status);

  await settleRetries(schedulePostprocessing(brokenDestination, "FOO", "lecturer@example.com"));

  expect(requests.length).toBe(1);
  expect(vi.mocked(showError)).toHaveBeenCalled();
  expect(vi.mocked(showSuccess)).not.toHaveBeenCalled();
});

test("a permanent failure still reports the server's explanation", async () => {
  useRetryClock();

  window.fetch = vi.fn()
    .mockImplementation(async () => new Response("recording name is not acceptable", { status: 422 }));

  await settleRetries(
    sendChunkToServer(brokenDestination, chunkOf(), "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 })
  );

  // giving up early must not cost the diagnosis: without the body the user sees a bare
  // status code for a mistake only the message explains
  expect(vi.mocked(showError)).toHaveBeenCalledWith(
    expect.stringContaining("recording name is not acceptable")
  );
});

// --- purging ---------------------------------------------------------------
//
// The request that deletes a recording for good. What the lecturer has to confirm first is
// the dialog's business, in ProcessedRecordingsSection.test.tsx; this is what happens once
// they have.

const API = "http://record.example.com";

test("a purge sends one authenticated DELETE for the recording", async () => {
  window.fetch = vi.fn().mockResolvedValue(Response.json({ recording: "GVS_2025" }));
  const refresh = vi.fn();

  await purgeRecording(API, "GVS_2025", accessToken, refresh);

  expect(window.fetch).toHaveBeenCalledExactlyOnceWith(
    `${API}/api/recordings/GVS_2025`,
    expect.objectContaining({ method: "DELETE" })
  );
  const request = vi.mocked(window.fetch).mock.calls[0][1] as RequestInit;
  expect((request.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
});

test("a purged recording name is percent-encoded into the path", async () => {
  // a name is a path segment here, so anything the browser would not encode on its own
  // has to be encoded before it gets there
  window.fetch = vi.fn().mockResolvedValue(Response.json({}));

  await purgeRecording(API, "Übung_2025", accessToken, vi.fn());

  expect(vi.mocked(window.fetch).mock.calls[0][0]).toBe(`${API}/api/recordings/${encodeURIComponent("Übung_2025")}`);
});

test("a successful purge is confirmed and refreshes the listing", async () => {
  window.fetch = vi.fn().mockResolvedValue(Response.json({ recording: "GVS_2025" }));
  const refresh = vi.fn();

  await purgeRecording(API, "GVS_2025", accessToken, refresh);

  expect(refresh).toHaveBeenCalledOnce();
  expect(showSuccess).toHaveBeenCalledWith(expect.stringContaining("GVS_2025"));
  expect(showError).not.toHaveBeenCalled();
});

test("nothing is sent without an access token", async () => {
  // the endpoint would refuse it anyway; asking without a token only produces a 401 that
  // says less than this
  window.fetch = vi.fn();
  const refresh = vi.fn();

  await purgeRecording(API, "GVS_2025", noAccessToken, refresh);

  expect(window.fetch).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("Not authenticated"));
});

test("a refused purge shows the server's explanation and still refreshes", async () => {
  // a 409 means the listing was stale -- the recording started rendering in the meantime --
  // so fetching it again is what brings the page up to date
  window.fetch = vi.fn().mockResolvedValue(
    Response.json({ detail: "Recording GVS_2025 is in use and currently not purgeable" }, { status: 409 })
  );
  const refresh = vi.fn();

  await purgeRecording(API, "GVS_2025", accessToken, refresh);

  expect(refresh).toHaveBeenCalledOnce();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("in use and currently not purgeable"));
  expect(showSuccess).not.toHaveBeenCalled();
});

test("a refusal whose detail is not a string is not stringified", async () => {
  // FastAPI answers a validation failure with an array of issue objects
  window.fetch = vi.fn().mockResolvedValue(
    Response.json({ detail: [ { loc: [ "path", "recording" ], msg: "String should match pattern" } ] }, { status: 422 })
  );

  await purgeRecording(API, "GVS_2025", accessToken, vi.fn());

  const message = vi.mocked(showError).mock.calls[0][0] as string;
  expect(message).toContain("Unknown error");
  expect(message).not.toContain("[object Object]");
});

test("a refusal that is not JSON still says something", async () => {
  window.fetch = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

  await purgeRecording(API, "GVS_2025", accessToken, vi.fn());

  expect(showError).toHaveBeenCalledWith(expect.stringContaining("Unknown error"));
});

test("a backend that cannot be reached is reported rather than thrown", async () => {
  // the dialog awaits this and then closes; a rejection would leave it stuck half-busy
  window.fetch = vi.fn().mockRejectedValue(new TypeError("NetworkError when attempting to fetch resource."));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(purgeRecording(API, "GVS_2025", accessToken, vi.fn())).resolves.toBeUndefined();

  expect(showError).toHaveBeenCalledWith(expect.stringContaining("NetworkError"));
  error.mockRestore();
});

test("the download URL carries the user, the encoded recording name and the OTP", () => {
  expect(downloadUrl(API, "8f14e45f", "Übung_2025", "0123456789"))
    .toBe(`${API}/api/recordings/8f14e45f/${encodeURIComponent("Übung_2025")}?totp=0123456789`);
});

// --- uploading a whole file in chunks --------------------------------------
//
// The manual re-upload sends a locally saved track the same way the live recording does:
// as numbered chunks, which the backend joins byte for byte. So the split points can fall
// anywhere, and what matters is that the pieces add up to the file, in order, with no gap.

const MiB = 2 ** 20;
const CHUNK = 4 * MiB;

const uploadDestination: ServerStorageDestination = {
  apiUrl: API,
  streamingImpeded: false,
  getAccessToken: accessToken
};

/** Every chunk request fetch() received, with the form fields the backend reads. */
async function sentChunks() {
  return Promise.all(vi.mocked(window.fetch).mock.calls.map(async ([ url, request ]) => {
    const form = (request as RequestInit).body as FormData;
    const chunk = form.get("chunk") as Blob;

    return {
      url,
      recording: form.get("recording"),
      track: form.get("track"),
      index: Number(form.get("index")),
      bytes: new Uint8Array(await chunk.arrayBuffer())
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

test("a file larger than a chunk goes up as numbered chunks that add up to it", async () => {
  window.fetch = vi.fn().mockImplementation(async () => Response.json({}, { status: 201 }));
  const { bytes, blob } = fileOf(2 * CHUNK + 12345);

  await expect(uploadFile(uploadDestination, blob, "GVS_2025-manual", "stream")).resolves.toBe(true);

  const chunks = await sentChunks();

  expect(chunks.map(c => c.index)).toStrictEqual([ 0, 1, 2 ]);
  expect(chunks.map(c => c.bytes.length)).toStrictEqual([ CHUNK, CHUNK, 12345 ]);
  expect(chunks.every(c => c.url === `${API}/api/chunks` && c.recording === "GVS_2025-manual" && c.track === "stream")).toBe(true);

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
  window.fetch = vi.fn().mockImplementation(async () => Response.json({}, { status: 201 }));

  await uploadFile(uploadDestination, fileOf(2 * CHUNK).blob, "GVS_2025-manual", "stream");

  expect((await sentChunks()).map(c => c.bytes.length)).toStrictEqual([ CHUNK, CHUNK ]);
});

test("a file smaller than a chunk goes up as chunk 0", async () => {
  window.fetch = vi.fn().mockImplementation(async () => Response.json({}, { status: 201 }));

  await uploadFile(uploadDestination, fileOf(1000).blob, "GVS_2025-manual", "overlay");

  expect((await sentChunks()).map(c => [ c.index, c.bytes.length ])).toStrictEqual([ [ 0, 1000 ] ]);
});

test("an empty file sends nothing and counts as uploaded", async () => {
  window.fetch = vi.fn();

  await expect(uploadFile(uploadDestination, new Blob([]), "GVS_2025-manual", "audio-0")).resolves.toBe(true);

  expect(window.fetch).not.toHaveBeenCalled();
});

test("the upload stops at the first chunk that fails", async () => {
  // the rest would only land behind a gap, which the backend treats as the end of the track
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => Response.json({}, { status: 201 }))
    .mockImplementation(async () => Response.json({ detail: "disk full" }, { status: 507 }));

  const result = await uploadFile(uploadDestination, fileOf(3 * CHUNK).blob, "GVS_2025-manual", "stream", undefined, { retries: 0, intervalMillis: 0 });

  expect(result).toBe(false);
  expect((await sentChunks()).map(c => c.index)).toStrictEqual([ 0, 1 ]);
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("chunk 1"));
});

test("progress is signalled with the size of every chunk that arrived", async () => {
  window.fetch = vi.fn().mockImplementation(async () => Response.json({}, { status: 201 }));
  const signalProgress = vi.fn();

  await uploadFile(uploadDestination, fileOf(2 * CHUNK + 12345).blob, "GVS_2025-manual", "stream", signalProgress);

  // byte counts rather than a percentage: the caller adds them up across tracks
  expect(signalProgress.mock.calls).toStrictEqual([ [ CHUNK ], [ CHUNK ], [ 12345 ] ]);
});

test("a chunk that failed is not counted as progress", async () => {
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => Response.json({}, { status: 201 }))
    .mockImplementation(async () => Response.json({ detail: "disk full" }, { status: 507 }));
  const signalProgress = vi.fn();

  await uploadFile(uploadDestination, fileOf(3 * CHUNK).blob, "GVS_2025-manual", "stream", signalProgress, { retries: 0, intervalMillis: 0 });

  expect(signalProgress.mock.calls).toStrictEqual([ [ CHUNK ] ]);
});

test("retries of a chunk are not counted twice", async () => {
  window.fetch = vi.fn()
    .mockImplementationOnce(async () => Response.json({}, { status: 503 }))
    .mockImplementation(async () => Response.json({}, { status: 201 }));
  const signalProgress = vi.fn();

  await expect(uploadFile(uploadDestination, fileOf(1000).blob, "GVS_2025-manual", "stream", signalProgress, { retries: 1, intervalMillis: 0 })).resolves.toBe(true);

  expect(window.fetch).toHaveBeenCalledTimes(2);
  expect(signalProgress.mock.calls).toStrictEqual([ [ 1000 ] ]);
});

test("nothing is uploaded without a backend", async () => {
  window.fetch = vi.fn();

  await expect(uploadFile({ ...uploadDestination, apiUrl: undefined }, fileOf(1000).blob, "GVS_2025-manual", "stream")).resolves.toBe(false);

  expect(window.fetch).not.toHaveBeenCalled();
});
