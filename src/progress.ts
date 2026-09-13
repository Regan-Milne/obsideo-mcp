/**
 * Live status for slow tool calls.
 *
 * A stdio server cannot draw a spinner, but MCP has progress notifications:
 * when the client passes a progressToken with the call, the server may send
 * "step, total, message" updates and the client renders them as a status
 * line. Clients without support ignore them. The first call on a fresh
 * machine (account creation, credential propagation) takes 20 to 50 seconds
 * and used to look frozen; this is what makes it look like a wait instead.
 *
 * The reporter is scoped to the current tool call with AsyncLocalStorage so
 * deep helpers (trial provisioning, propagation retries) can report without
 * threading a parameter through every signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface Reporter {
  (message: string, progress?: number, total?: number): Promise<void>;
}

const store = new AsyncLocalStorage<Reporter>();

/** Build a reporter from the tool handler's `extra` argument. */
export function reporterFrom(extra: any): Reporter {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || typeof send !== "function") return async () => {};
  let step = 0;
  return async (message, progress, total) => {
    step = progress ?? step + 1;
    try {
      await send({
        method: "notifications/progress",
        params: { progressToken: token, progress: step, total, message },
      });
    } catch {
      /* a client that rejects progress must not fail the tool */
    }
  };
}

/** Run `fn` with `reporter` as the ambient reporter for this call. */
export function withReporter<T>(reporter: Reporter, fn: () => Promise<T>): Promise<T> {
  return store.run(reporter, fn);
}

/** Report from anywhere inside a tool call; a no-op outside one. */
export async function report(message: string, progress?: number, total?: number): Promise<void> {
  const r = store.getStore();
  if (r) await r(message, progress, total);
}

/** Sleep `ms`, reporting a countdown line every `every` ms. */
export async function sleepWithCountdown(ms: number, label: string, every = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (true) {
    const left = end - Date.now();
    if (left <= 0) return;
    await report(`${label} (about ${Math.ceil(left / 1000)} s remaining)`);
    await new Promise((r) => setTimeout(r, Math.min(every, left)));
  }
}
