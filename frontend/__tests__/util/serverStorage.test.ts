import { expect, test, vi } from "vitest";
import { sendChunkToServer, schedulePostprocessing, ServerStorageDestination } from "@/lib/utils/serverStorage";
import { showError } from "@/lib/utils/notifications";

interface FetchRequest {
  url: string | URL | Request
  data?: RequestInit
}

vi.mock("@/lib/utils/notifications");

const accessToken = async () => "test-token";
const noAccessToken = async () => undefined;

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

  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 10, intervalMillis: 50 });

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

test("sending chunk to broken server", { timeout: 30000 }, async () => {
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

  const before = new Date();
  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 });
  const after = new Date();

  expect(vi.mocked(showError)).toHaveBeenCalled();

  expect(fetchRequests.length).toBe(4);
  expect(after.getTime() - before.getTime()).toBeGreaterThan(149);
  expect(after.getTime() - before.getTime()).toBeLessThan(200);

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
});

test("schedule postprocessing to flaky server", async () => {
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

  await schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 5, intervalMillis: 50 });

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

  const before = new Date();
  await schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 3, intervalMillis: 50 });
  const after = new Date();

  expect(fetchRequests.length).toBe(4);
  expect(after.getTime() - before.getTime()).toBeGreaterThan(149);
  expect(after.getTime() - before.getTime()).toBeLessThan(200);
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

  await sendChunkToServer(destination, chunk, "FOO", "stream.webm", 42, { retries: 10, intervalMillis: 50 });

  expect(fetchRequests.length).toBe(2);
  expect(fetchRequests[0].data?.headers).toStrictEqual({ Authorization: "Bearer test-token-1" });
  expect(fetchRequests[1].data?.headers).toStrictEqual({ Authorization: "Bearer test-token-2" });
});

test("postprocessing request requests a fresh access token for every attempt", async () => {
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

  await schedulePostprocessing(destination, "FOO", "lecturer@example.com", { retries: 5, intervalMillis: 50 });

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
