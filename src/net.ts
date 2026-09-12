/**
 * fetch with one retry on a transport-level failure ("fetch failed": DNS,
 * TLS, reset, timeout before any HTTP status). A stranger's very first tool
 * call must not die on a single transient network blip with a three-word
 * error. HTTP errors (4xx/5xx) are NOT retried here; callers handle those.
 */
export async function fetchOnce(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg)) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await fetch(url, init);
    } catch (e2) {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      throw new Error(
        `Network error reaching ${host} (tried twice: ${e2 instanceof Error ? e2.message : String(e2)}). ` +
          "Check the connection and retry the same call; nothing was changed on the account."
      );
    }
  }
}
