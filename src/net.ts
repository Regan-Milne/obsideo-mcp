/**
 * fetch with a hard timeout and one retry on a transport-level failure.
 *
 * Without a timeout a stalled connection hangs a tool call for as long as the
 * client is willing to wait (a real user's first `usage` call sat for ~14
 * minutes on 2026-09-12). Without a retry a single transient blip ("fetch
 * failed": DNS, TLS, reset) turns a stranger's first call into a three-word
 * error. HTTP errors (4xx/5xx) are not retried here; callers handle those.
 */

export const REQUEST_TIMEOUT_MS = 30_000;

function transient(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|TimeoutError|AbortError/i.test(msg);
}

export interface FetchOpts {
  /** Retry once on a transport failure. Default: only for GET. A POST that
   *  creates something (redeem a ticket, verify a code) must NOT be retried
   *  after a timeout: the server may have completed it. */
  retry?: boolean;
  timeoutMs?: number;
}

export async function fetchOnce(url: string, init?: RequestInit, opts: FetchOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retry = opts.retry ?? (init?.method ?? "GET").toUpperCase() === "GET";
  const attempt = () => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    return await attempt();
  } catch (e) {
    if (!transient(e)) throw e;
    if (!retry) {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      throw new Error(
        `Network error reaching ${host} (${timeoutMs / 1000} s limit: ${e instanceof Error ? e.message : String(e)}). ` +
          "This call was not retried automatically because the server may have completed it; check state (usage) before calling again."
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await attempt();
    } catch (e2) {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      const why = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(
        `Network error reaching ${host} (tried twice, ${timeoutMs / 1000} s limit each: ${why}). ` +
          "Check the connection and retry the same call; nothing was changed on the account."
      );
    }
  }
}
