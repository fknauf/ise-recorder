import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { anAppSession } from "../helpers/session";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { useServerStorage, useRefreshServerStorage } from "@/lib/hooks/useServerStorage";
import { useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";
import { ServerStorageRecording } from "@/lib/utils/serverStorage";
import { ApiError } from "@/lib/utils/apiFetch";
import * as z from "zod";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

const mockServerEnv = vi.fn();
vi.mock("@/lib/hooks/useServerEnv", () => ({
  useServerEnv: () => mockServerEnv()
}));

// a rerender reports to whoever is in the lecture form, which lives in the app store; a
// factory keeps the store out of these tests
vi.mock("@/lib/hooks/useLecture", () => ({
  useLecture: () => ({ lecturerEmail: LECTURER_EMAIL })
}));

const API_URL = "https://record.example.edu";
const LECTURER_EMAIL = "lecturer@example.edu";

type AppSession = ReturnType<typeof useAppSession>;

const session = (getAccessToken: AppSession["getAccessToken"], isAuthenticated = true): AppSession =>
  anAppSession({ getAccessToken, isAuthenticated });

const USER_DIGEST = "8f14e45fceea167a";

/** The backend lists every recording in one array, whatever state it is in, sorted by name. */
const sorted = (listing: ServerStorageRecording[]) => listing.toSorted((a, b) => a.name.localeCompare(b.name));

const LISTING: ServerStorageRecording[] = [
  { state: "rendering", name: "ABC_2026" },
  { state: "completed", name: "GVS_2025", size: 1024, downloadUrl: `downloads/${USER_DIGEST}/GVS_2025?totp=012345` },
  { state: "completed", name: "PSU_2026", size: 2048, downloadUrl: `downloads/${USER_DIGEST}/PSU_2026?totp=987654` },
  { state: "unprocessed", name: "XYZ_2024" }
];

/** The listing with one recording turned into a rendering one, in the place it already had. */
const asRendering = (listing: ServerStorageRecording[], name: string): ServerStorageRecording[] =>
  listing.map(rec => (rec.name === name ? { state: "rendering", name } : rec));

/**
 * SWR keeps one cache per provider, and it is global by default -- a listing fetched in
 * one test would be served from cache as the initial data of the next one, hiding whether
 * the hook fetched at all. A fresh Map per render isolates them.
 *
 * Note that anything which drives a revalidation or a mutation by hand -- `refresh()`,
 * `purge()` and `rerender()` below -- has to run inside act(): what settles at the end of it
 * is React state, and React warns about the update otherwise.
 */
function swrWrapper() {
  const Wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>;

  Wrapper.displayName = "SwrTestWrapper";
  return Wrapper;
}

function renderServerStorageRecordings(
  {
    serverEnv = { apiUrl: API_URL } as ServerEnv,
    getAccessToken = (async () => "test-token") as AppSession["getAccessToken"],
    isAuthenticated = true
  } = {}
) {
  mockServerEnv.mockReturnValue(serverEnv);
  mockUseAppSession.mockReturnValue(session(getAccessToken, isAuthenticated));

  return renderHook(useServerStorage, { wrapper: swrWrapper() });
}

/**
 * A Response body can only be read once, so every one of these has to be built per call --
 * mockResolvedValue would hand the same instance to the second poll and turn it into a
 * "body stream already read" failure that looks exactly like a malformed listing.
 */
const respondWith = (make: () => Response) => fetchMock.mockImplementation(async () => make());

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

/** Every request goes out as a single Request object, so that is all a call carries. */
const requestAt = (index: number) => fetchMock.mock.calls[index][0] as Request;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the listing is fetched from the configured backend with the access token", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  expect(fetchMock).toHaveBeenCalledTimes(1);

  const request = requestAt(0);

  expect(request.url).toBe(`${API_URL}/api/recordings`);
  expect(request.method).toBe("GET");
  // the listing is per-user, so it has to be authenticated -- unlike the download itself,
  // which carries a TOTP in the query string because a link cannot set a header
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
});

test("nothing is fetched when the deployment has no backend", async () => {
  const { result } = renderServerStorageRecordings({ serverEnv: {} });

  // the null SWR key is what disables the poll; without it the hook would retry against
  // "undefined/api/recordings" every minute for the whole session
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.data).toBeUndefined();
});

test("nothing is fetched while nobody is signed in", async () => {
  const { result } = renderServerStorageRecordings({ isAuthenticated: false });

  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.data).toBeUndefined();
  // not a failure, so no alert: there is simply no listing to have
  expect(result.current.error).toBeUndefined();
});

test("signing in fetches the listing without waiting for the poll", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result, rerender } = renderServerStorageRecordings({ isAuthenticated: false });

  await waitFor(() => expect(result.current.isLoading).toBe(false));

  mockUseAppSession.mockReturnValue(session(async () => "test-token", true));
  rerender();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("signing out drops the listing", async () => {
  // every TOTP in it is a download link, and they are not the next user's to have
  respondWith(() => jsonResponse(LISTING));

  const { result, rerender } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  mockUseAppSession.mockReturnValue(session(async () => undefined, false));
  rerender();

  await waitFor(() => expect(result.current.data).toBeUndefined());
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("a signed-in session that yields no token is a failure rather than an empty listing", async () => {
  // what is left when a renewal failed: the session still says signed in, but there is
  // nothing to send. An empty listing would tell the lecturer they have no recordings.
  // The request goes out without credentials, and the backend's refusal of it -- what
  // FastAPI's bearer scheme answers -- is what makes it a failure.
  fetchMock.mockImplementation(async (request: Request) => (
    request.headers.has("Authorization")
      ? jsonResponse(LISTING)
      : jsonResponse({ detail: "Not authenticated" }, 401)
  ));

  const { result } = renderServerStorageRecordings({ getAccessToken: async () => undefined });

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(requestAt(0).headers.has("Authorization")).toBe(false);
  expect(result.current.error.message).toContain("401");
  expect(result.current.data).toBeUndefined();
});

test("a fresh token is requested for every poll rather than captured once", async () => {
  // the listing refreshes on an interval for as long as the page is open, which outlives
  // any single access token
  const getAccessToken = vi.fn()
    .mockResolvedValueOnce("first-token")
    .mockResolvedValue("second-token");

  respondWith(() => jsonResponse(LISTING));

  const { result } = renderServerStorageRecordings({ getAccessToken });

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  await act(async () => {
    await result.current.refresh();
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(requestAt(1).headers.get("Authorization")).toBe("Bearer second-token");
});

// --- what a failure does ---------------------------------------------------
//
// The fetcher throws rather than resolving with null, so failures reach SWR's error state
// and the section can say what went wrong. Two consequences come with that and are pinned
// below: SWR keeps the last `data` alongside the error, so hiding the stale listing is the
// section's job and not the hook's; and refreshInterval is suspended while an error is
// cached, so the error-retry chain -- not the minute poll -- is what keeps trying.

test("re-rendering does not set off another request", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result, rerender } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  // The fetcher may be built afresh on any render, which is fine because SWR reads it
  // through a ref at revalidation time -- and is what keeps the retry chain on the current
  // getAccessToken. It would not be fine if its identity reached the key.
  rerender();
  rerender();

  await act(async () => {});

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a rejected listing surfaces the status and the server's explanation", async () => {
  // what FastAPI answers an HTTPException with
  respondWith(() => jsonResponse({ detail: "Not authenticated" }, 401));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  // the section renders this straight into an alert, so it has to say which of "the
  // backend is down", "you are not allowed" and "it sent nonsense" actually happened
  expect(result.current.error).toBeInstanceOf(Error);
  expect(result.current.error.message).toContain("401");
  expect(result.current.error.message).toContain("Not authenticated");
});

test("a body that is not JSON is left out rather than put on screen", async () => {
  // a gateway between the browser and the backend answers in HTML, not in FastAPI's
  // shape. The status alone is the useful part; the page would fill the alert.
  respondWith(() => new Response(
    "<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>",
    { status: 502, headers: { "Content-Type": "text/html" } }
  ));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error.message).toContain("502");
  expect(result.current.error.message).not.toContain("<");
});

// A JSON body is not necessarily a FastAPI body. Anything in front of the backend can
// answer JSON of its own shape, and reading `detail` off it without checking what came
// back puts "undefined" in front of the lecturer. FastAPI itself has a second shape too:
// a RequestValidationError's detail is an array of issue objects, which interpolates as
// "[object Object]". Requiring a string covers both.
test("a JSON body with no string detail is left out rather than stringified", async () => {
  respondWith(() => jsonResponse({ error: "upstream refused" }, 503));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error.message).toContain("503");
  expect(result.current.error.message).not.toContain("undefined");
});

test("a malformed listing is a failure rather than something to render", async () => {
  // size as a string is what a backend change would most plausibly produce, and it would
  // otherwise reach the MiB formatter as NaN
  respondWith(() => jsonResponse([ { state: "completed", name: "x", size: "1024", downloadUrl: "downloads/u/x?totp=1" } ]));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  // the section branches on this to prettify it, so an ApiError of its own kind with zod's
  // error kept as the cause, rather than zod's message alone, is part of the contract
  expect(result.current.error).toBeInstanceOf(ApiError);
  expect(result.current.error.kind).toBe("invalid-response");
  expect(result.current.error.cause).toBeInstanceOf(z.ZodError);
  expect(result.current.data).toBeUndefined();
});

test("a backend that cannot be reached at all fails the same way", async () => {
  // fetch() rejects rather than resolving when the request never got an answer -- backend
  // down, DNS, CORS, the machine offline. That path is wrapped into an ApiError of its own
  // kind, with the TypeError kept as its cause, and thrown like the others.
  const unreachable = new TypeError("NetworkError when attempting to fetch resource.");
  fetchMock.mockRejectedValue(unreachable);

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(ApiError);
  expect(result.current.error.kind).toBe("network");
  expect(result.current.error.cause).toBe(unreachable);
});

test("a failed poll leaves the previous listing in the cache for the section to suppress", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result } = renderServerStorageRecordings();

  // read `error` before the failure, not only after it: SWR tracks which fields the caller
  // touches and skips the re-render when an untouched one changes, so waiting on `error`
  // for the first time after the fact would wait forever
  await waitFor(() => expect(result.current.data).toEqual(LISTING));
  expect(result.current.error).toBeUndefined();

  respondWith(() => new Response("nope", { status: 500 }));

  await act(async () => {
    await result.current.refresh().catch(() => null);
  });

  await waitFor(() => expect(result.current.error).toBeDefined());

  // SWR holds the last good data through an error. Every TOTP in it is good for one
  // interval, so a section that rendered `data` without checking `error` would go on
  // offering links that have already stopped working.
  expect(result.current.data).toEqual(LISTING);
});

test("a recovered poll clears the error so the minute refresh resumes", async () => {
  respondWith(() => new Response("nope", { status: 500 }));

  const { result } = renderServerStorageRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  respondWith(() => jsonResponse(LISTING));

  await act(async () => {
    await result.current.refresh();
  });

  // refreshInterval skips revalidation entirely while an error is cached, so clearing it
  // is what hands the polling back from the retry chain to the interval
  await waitFor(() => expect(result.current.error).toBeUndefined());
  expect(result.current.data).toEqual(LISTING);
});

// --- refreshing from outside the section -----------------------------------
//
// useRefreshServerStorage is what the recorder calls once a recording is finished.
// It goes through the mutate of the nearest SWRConfig, so it has to reach the same cache
// the listing lives in -- here the fresh-Map wrapper's, which the global mutate would miss.

test("a refresh fetches the listing again without waiting for the poll", async () => {
  mockServerEnv.mockReturnValue({ apiUrl: API_URL });
  mockUseAppSession.mockReturnValue(session(async () => "test-token"));

  const after = sorted([ ...LISTING, { state: "rendering", name: "NEW_2026" } ]);

  respondWith(() => jsonResponse(LISTING));

  const { result } = renderHook(
    () => ({ listing: useServerStorage(), refresh: useRefreshServerStorage() }),
    { wrapper: swrWrapper() }
  );

  await waitFor(() => expect(result.current.listing.data).toEqual(LISTING));

  respondWith(() => jsonResponse(after));

  await act(async () => {
    await result.current.refresh();
  });

  await waitFor(() => expect(result.current.listing.data).toEqual(after));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a refresh from outside the listing's cache does not reach it", async () => {
  // the counterpart of the above: the refresh is scoped to its SWRConfig. A recorder
  // mounted under a different cache than the section would refresh nothing, which is
  // what the e2e test guards against for the real page.
  mockServerEnv.mockReturnValue({ apiUrl: API_URL });
  mockUseAppSession.mockReturnValue(session(async () => "test-token"));

  respondWith(() => jsonResponse(LISTING));

  const listing = renderHook(useServerStorage, { wrapper: swrWrapper() });
  const elsewhere = renderHook(useRefreshServerStorage, { wrapper: swrWrapper() });

  await waitFor(() => expect(listing.result.current.data).toEqual(LISTING));

  await act(async () => {
    await elsewhere.result.current();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// --- purging and rerendering -----------------------------------------------
//
// Both go through the listing's own mutate, so the card moves the moment the lecturer has
// pressed the button and moves back if the backend refuses. Whether a request goes out is
// the listing's business here; which toast follows is the section's, in
// ServerStorageSection.test.tsx.

/**
 * Answers each endpoint the hook talks to with a builder of its own: the listing, the DELETE
 * of a purge and the render request of a rerender. One that is left out is never answered, so
 * whatever is on screen meanwhile is what the cache holds.
 */
function backend(
  { listing, purge, job }: Partial<Record<"listing" | "purge" | "job", () => Response>>
) {
  fetchMock.mockImplementation(async (request: Request) => {
    let make = listing;

    if(request.method === "DELETE") {
      make = purge;
    } else if(request.method === "POST" && request.url.endsWith("/render")) {
      make = job;
    }

    return make === undefined ? new Promise<Response>(() => {}) : make();
  });
}

const requestsOf = (method: string) =>
  fetchMock.mock.calls.map(([ request ]) => request as Request).filter(request => request.method === method);

/** What the backend answers a purge with: nothing. */
const purged = () => new Response(null, { status: 204 });

/** What the backend answers an accepted rerender with: the recording's new state. */
const accepted = (name: string) => () => jsonResponse({ state: "rendering", name }, 202);

/** The hook over LISTING, once that is in. */
async function renderWithListing(listing = LISTING) {
  backend({ listing: () => jsonResponse(listing) });

  const rendered = renderServerStorageRecordings();

  await waitFor(() => expect(rendered.result.current.data).toEqual(listing));
  return rendered;
}

const names = (listing: ServerStorageRecording[] | undefined) => listing?.map(rec => rec.name);

test("a purge sends the DELETE for that recording", async () => {
  const { result } = await renderWithListing();

  backend({ purge: purged });

  await act(async () => {
    await result.current.purge("PSU_2026");
  });

  const [ request ] = requestsOf("DELETE");

  expect(request.url).toBe(`${API_URL}/api/recordings/PSU_2026`);
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
});

test("a purged recording leaves the listing before the backend has answered", async () => {
  const { result } = await renderWithListing();

  // the DELETE is never answered
  backend({});

  act(() => {
    void result.current.purge("PSU_2026");
  });

  await waitFor(() => expect(names(result.current.data)).toStrictEqual([ "ABC_2026", "GVS_2025", "XYZ_2024" ]));
  // the others are filtered by name too, and lose nothing that is not called that
  expect(result.current.data).toStrictEqual(LISTING.filter(rec => rec.name !== "PSU_2026"));
});

test("a purged recording leaves the listing whichever kind it is", async () => {
  const { result } = await renderWithListing();

  backend({});

  act(() => {
    void result.current.purge("XYZ_2024");
  });

  await waitFor(() => expect(names(result.current.data)).toStrictEqual([ "ABC_2026", "GVS_2025", "PSU_2026" ]));
  expect(result.current.data).toStrictEqual(LISTING.slice(0, 3));
});

test("a purge fetches the listing again rather than trusting its own guess", async () => {
  // the backend answers a purge with nothing, so anything else that changed on it in the
  // meantime only comes along with the listing fetched after it
  const { result } = await renderWithListing();

  const after = sorted([ ...LISTING.filter(rec => rec.name !== "PSU_2026"), { state: "rendering", name: "NEW_2026" } ]);

  backend({ listing: () => jsonResponse(after), purge: purged });

  let outcome: unknown = "unset";

  await act(async () => {
    outcome = await result.current.purge("PSU_2026");
  });

  // there is no listing in the answer to hand back
  expect(outcome).toBeUndefined();

  await waitFor(() => expect(result.current.data).toEqual(after));
  expect(requestsOf("GET")).toHaveLength(2);
});

test("a purged recording stays gone while the listing is fetched again", async () => {
  // the DELETE is through, but the listing that no longer has it is not in yet; the
  // recording must not come back in that window just because the cache was not written
  const { result } = await renderWithListing();

  backend({ purge: purged });

  await act(async () => {
    await result.current.purge("PSU_2026");
  });

  // give the held listing every chance to make a difference before checking that none did
  await act(async () => {});
  expect(requestsOf("GET")).toHaveLength(2);
  expect(names(result.current.data)).toStrictEqual([ "ABC_2026", "GVS_2025", "XYZ_2024" ]);
});

test("a refused purge puts the recording back and throws the server's explanation", async () => {
  const { result } = await renderWithListing();

  // the listing is held from here on, so nothing but the rollback can bring it back
  backend({ purge: () => jsonResponse({ detail: "Recording PSU_2026 is in use and currently not purgeable" }, 409) });

  let failure: unknown;

  await act(async () => {
    failure = await result.current.purge("PSU_2026").catch((e: unknown) => e);
  });

  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).message).toContain("Recording PSU_2026 is in use and currently not purgeable");
  expect(result.current.data).toEqual(LISTING);
  // the listing is fetched again after a refusal as well, but that one is held: what is on
  // screen is the rollback to the listing from before the purge
  expect(requestsOf("GET")).toHaveLength(2);
});

test("a purge the backend cannot be reached for puts the recording back", async () => {
  const { result } = await renderWithListing();

  fetchMock.mockRejectedValue(new TypeError("NetworkError when attempting to fetch resource."));

  let failure: unknown;

  await act(async () => {
    failure = await result.current.purge("PSU_2026").catch((e: unknown) => e);
  });

  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).kind).toBe("network");
  expect(result.current.data).toEqual(LISTING);
});

test("a rerender schedules a job for that recording with the form's recipient", async () => {
  const { result } = await renderWithListing();

  backend({ job: accepted("PSU_2026") });

  await act(async () => {
    await result.current.rerender("PSU_2026");
  });

  const [ request ] = requestsOf("POST");

  expect(request.url).toBe(`${API_URL}/api/recordings/PSU_2026/render`);
  // the recipient is whatever the lecture form holds now, not whoever got the first
  // report: the backend keeps no record of that
  expect(await request.json()).toStrictEqual({ recipient: LECTURER_EMAIL });
  expect(request.headers.get("Authorization")).toBe("Bearer test-token");
});

test("a rerender is not retried", async () => {
  // somebody is sitting in front of the button and can press it again; a retry loop would
  // only leave them waiting for no visible reason
  const { result } = await renderWithListing();

  backend({ job: () => jsonResponse({ detail: "upstream unavailable" }, 503) });

  await act(async () => {
    await result.current.rerender("PSU_2026")?.catch(() => null);
  });

  expect(requestsOf("POST")).toHaveLength(1);
});

test("a rerendered recording shows as rendering before the backend has answered", async () => {
  const { result } = await renderWithListing();

  // neither the job request nor the listing after it is answered
  backend({});

  act(() => {
    void result.current.rerender("PSU_2026");
  });

  // in the place it already had, which is the one the backend lists it in by name
  await waitFor(() => expect(result.current.data).toStrictEqual(asRendering(LISTING, "PSU_2026")));
});

test("a failed recording that is rerendered shows as rendering the same way", async () => {
  const listing = sorted([ ...LISTING.filter(rec => rec.state === "completed"), { state: "rendering", name: "XYZ_2026" }, { state: "unprocessed", name: "OLD_2024" } ]);
  const { result } = await renderWithListing(listing);

  backend({});

  act(() => {
    void result.current.rerender("OLD_2024");
  });

  await waitFor(() => expect(result.current.data).toStrictEqual(asRendering(listing, "OLD_2024")));
  expect(result.current.data?.filter(rec => rec.state === "unprocessed")).toStrictEqual([]);
});

test("an accepted rerender fetches the listing again rather than trusting its own guess", async () => {
  // the job request answers with the one recording's new state, which stands in for it
  // only until the listing is back
  const { result } = await renderWithListing();

  const after = asRendering(LISTING.filter(rec => rec.state !== "unprocessed"), "PSU_2026");

  backend({ listing: () => jsonResponse(after), job: accepted("PSU_2026") });

  await act(async () => {
    await result.current.rerender("PSU_2026");
  });

  await waitFor(() => expect(result.current.data).toEqual(after));
  expect(requestsOf("GET")).toHaveLength(2);
});

test("a refused rerender puts the recording back and throws the server's explanation", async () => {
  const { result } = await renderWithListing();

  // the listing after it is held, so nothing but the rollback can bring the card back
  backend({ job: () => jsonResponse({ detail: "Recording PSU_2026 is already rendering" }, 409) });

  let failure: unknown;

  await act(async () => {
    failure = await result.current.rerender("PSU_2026")?.catch((e: unknown) => e);
  });

  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).message).toContain("Recording PSU_2026 is already rendering");
  expect(result.current.data).toEqual(LISTING);
});

test("a refused rerender still fetches the listing again", async () => {
  // a refusal usually means the listing was out of date -- the recording is rendering
  // already, or gone -- so fetching it is what brings the card up to date
  const { result } = await renderWithListing();

  const after = asRendering(LISTING, "PSU_2026");

  backend({ listing: () => jsonResponse(after), job: () => jsonResponse({ detail: "Recording PSU_2026 is already rendering" }, 409) });

  await act(async () => {
    await result.current.rerender("PSU_2026")?.catch(() => null);
  });

  await waitFor(() => expect(result.current.data).toEqual(after));
  expect(requestsOf("GET")).toHaveLength(2);
});
