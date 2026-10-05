import * as z from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "http" | "invalid-response",
    readonly status?: number,
    readonly detail?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }

  get transient(): boolean {
    return this.kind === "network" ||
      this.status === 401 || // treat 401 as transient to work in case of auth server brownout
      this.status === 408 ||
      this.status === 429 ||
      (this.status !== undefined && this.status >= 500);
  }
}

export interface ApiDestination {
  apiUrl: string
  getAccessToken: () => Promise<string | undefined>
}

export interface RetryPolicy {
  retries: number
  initialWaitMillis: number
  maxWaitMillis: number
  backoffFactor: number
  abortSignal: AbortSignal | undefined
}

export const defaultRetryPolicy: RetryPolicy = {
  retries: 0,
  initialWaitMillis: 1000,
  maxWaitMillis: 60000,
  backoffFactor: 2,
  abortSignal: undefined
};

async function apiFetchResponse(
  dest: ApiDestination,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await dest.getAccessToken();
  const url = new URL(path, dest.apiUrl);

  const request = new Request(url, init);
  if(token !== undefined) {
    request.headers.set("Authorization", `Bearer ${token}`);
  }

  try {
    const response = await fetch(request);

    if(!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.detail === "string" ? body.detail : undefined;

      throw new ApiError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, "http", response.status, detail);
    }

    return response;
  } catch(e) {
    if(!request.signal.aborted && e instanceof TypeError) {
      throw new ApiError(`Network error: ${e.message}`, "network", undefined, undefined, { cause: e });
    }

    throw e;
  }
}

export async function apiFetchVoid(
  dest: ApiDestination,
  path: string,
  init?: RequestInit
) {
  await apiFetchResponse(dest, path, init);
}

export async function apiFetchData<T>(
  dest: ApiDestination,
  path: string,
  init: RequestInit | undefined,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await apiFetchResponse(dest, path, init);

  try {
    return schema.parse(await response.json());
  } catch(e) {
    if(init?.signal?.aborted) {
      throw e;
    }

    const message = e instanceof Error ? e.message : "unknown error";
    throw new ApiError(message, "invalid-response", response.status, undefined, { cause: e });
  }
}

const abortableTimeout = (timeoutMillis: number, abortSignal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if(abortSignal?.aborted) {
      resolve();
      return;
    }

    const abortHandler = () => {
      clearTimeout(timer);
      resolve();
    };

    const timeoutHandler = () => {
      abortSignal?.removeEventListener("abort", abortHandler);
      resolve();
    };

    const timer = setTimeout(timeoutHandler, timeoutMillis);
    abortSignal?.addEventListener("abort", abortHandler, { once: true });
  });

export async function withRetries<T>(
  fn: () => Promise<T>,
  retryPolicy: RetryPolicy
): Promise<T> {
  let attempt = 0;
  let waitMillis = retryPolicy.initialWaitMillis;

  while(true) {
    try {
      return await fn();
    } catch(e) {
      if(attempt === retryPolicy.retries || !(e instanceof ApiError && e.transient)) {
        throw e;
      }
    }

    await abortableTimeout(waitMillis, retryPolicy.abortSignal);
    retryPolicy.abortSignal?.throwIfAborted();
    waitMillis = Math.min(waitMillis * retryPolicy.backoffFactor, retryPolicy.maxWaitMillis);
    ++attempt;
  }
}
