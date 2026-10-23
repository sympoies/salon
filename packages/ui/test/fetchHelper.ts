type FetchMock = (url: string, init?: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

export function setFetchMock(mock: FetchMock): void {
  globalThis.fetch = mock as typeof fetch;
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}
