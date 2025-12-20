
import { expect, test, vi } from "vitest";
import { sendChunkToServer, schedulePostprocessing } from "@/app/lib/utils/serverStorage";
import { showError } from "@/app/lib/utils/notifications";

interface FetchRequest {
  url: string | URL | Request
  data?: RequestInit
}

vi.mock("@/app/lib/utils/notifications");

test("sending chunk to server", async () => {
  const apiUrl = "http://record.example.com";

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

  await sendChunkToServer(apiUrl, chunk, "FOO", "stream.webm", 42);


  expect(fetchRequest.url).toBe(`${apiUrl}/api/chunks`);
  expect(fetchRequest.data?.method).toBe("POST");
  expect(fetchRequest.data?.body).toBeInstanceOf(FormData);

  const requestBody = fetchRequest.data?.body as FormData;

  expect(requestBody.get("recording")).toStrictEqual("FOO");
  expect(requestBody.get("track")).toStrictEqual("stream.webm");
  expect(requestBody.get("index")).toStrictEqual("42");
  expect(await (requestBody.get("chunk") as File).text()).toStrictEqual(await chunk.text());
});

test("sending chunk to flaky server", async () => {
  const apiUrl = "http://record.example.com";
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

  await sendChunkToServer(apiUrl, chunk, "FOO", "stream.webm", 42);

  expect(fetchRequests.length).toBe(2);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${apiUrl}/api/chunks`);
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
  const apiUrl = "http://record.example.com";
  const chunk = new Blob([ "Hello, world." ], { type: "text/plain" });
  const fetchRequests: FetchRequest[] = [];

  window.fetch = vi.fn()
    .mockImplementation(async (url: string | URL | Request, data?: RequestInit): Promise<Response> => {
      fetchRequests.push({ url, data });
      return Response.json("", { status: 503 });
    });

  const before = new Date();
  await sendChunkToServer(apiUrl, chunk, "FOO", "stream.webm", 42, { retries: 3, intervalMillis: 50 });
  const after = new Date();

  expect(vi.mocked(showError)).toHaveBeenCalled();

  expect(fetchRequests.length).toBe(4);
  expect(after.getTime() - before.getTime()).toBeGreaterThan(150);
  expect(after.getTime() - before.getTime()).toBeLessThan(200);

  for(const req of fetchRequests) {
    expect(req.url).toBe(`${apiUrl}/api/chunks`);
    expect(req.data?.method).toBe("POST");
    expect(req.data?.body).toBeInstanceOf(FormData);

    const requestBody = req.data?.body as FormData;

    expect(requestBody.get("recording")).toStrictEqual("FOO");
    expect(requestBody.get("track")).toStrictEqual("stream.webm");
    expect(requestBody.get("index")).toStrictEqual("42");
    expect(await (requestBody.get("chunk") as File).text()).toStrictEqual(await chunk.text());
  }
});
