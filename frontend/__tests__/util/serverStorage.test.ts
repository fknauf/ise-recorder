import { afterEach, expect, test, vi } from "vitest";
import { sendChunkToServer, schedulePostprocessing, ServerStorageDestination } from "@/lib/utils/serverStorage";
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
