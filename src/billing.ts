/**
 * Paid plan (Stripe fiat rail) — control plane only, via the signup service.
 *
 * Consent model, in order of who decides:
 *   - `upgrade` never charges anything. It returns a Stripe-hosted checkout
 *     URL; the human opens it and pays (or does not) on Stripe's page.
 *   - This server never changes the size of an existing plan. The only
 *     paths that do are the agree link Obsideo emails at ~90% of the tier
 *     and the customer's own explicit API call. An agent must not be able
 *     to grow a bill on its human's behalf, so no stepup tool is exposed.
 *   - `portal` returns the Stripe Customer Portal URL: cancel, card, invoices.
 *
 * Stripe sees an email and a card; never an S3 credential, key, or byte.
 */

import { loadConfig } from "./config.js";

const SIGNUP_BASE = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";

export interface PlanStatus {
  enabled: boolean;
  plan: string;
  blocks: number;
  block_gb: number;
  block_price_usd: number;
  monthly_usd: number;
  status: string | null;
  period_end: string | null;
  cancel_at_period_end: boolean;
  pending_upgrade: {
    to_blocks: number;
    from_blocks: number;
    new_quota_gb: number;
    new_monthly_usd: number;
    agree_url: string;
    expires_at: string;
  } | null;
}

class BillingHttpError extends Error {
  constructor(public status: number, public detail: any) {
    super(`HTTP ${status}: ${JSON.stringify(detail)}`);
  }
}

async function authed(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const cfg = loadConfig();
  if (!cfg.account_token) {
    throw new Error(
      "No Obsideo account is configured on this machine. Store something first (a free " +
        "trial is created automatically) or run signup_start + signup_verify, then retry."
    );
  }
  const resp = await fetch(SIGNUP_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.account_token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Signup service returned ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.ok) throw new BillingHttpError(resp.status, json.detail ?? json);
  return json;
}

function isDisabled(e: unknown): boolean {
  return e instanceof BillingHttpError && e.status === 404 && e.detail?.error === "billing_disabled";
}

const DISABLED_MSG =
  "Card billing is not switched on for this service yet. The free tier still works; " +
  "reply to any Obsideo email to ask for more space in the meantime.";

/** Human-readable plan summary from the service's billing block. */
export function describePlan(b: PlanStatus, cfg = loadConfig()): string {
  const lines: string[] = [];
  if (!b.enabled) {
    lines.push("Card billing: not enabled on this service yet (free tier only).");
  } else if (b.plan === "free" || !b.blocks) {
    lines.push(
      `Plan: free tier. Paid plans are ${b.block_gb} GB blocks at $${b.block_price_usd.toFixed(2)}/month ` +
        "each; call `upgrade` for a checkout link (nothing is charged until the human completes it)."
    );
  } else {
    lines.push(
      `Plan: ${b.blocks} x ${b.block_gb} GB = ${(b.blocks * b.block_gb).toFixed(1)} GB for ` +
        `$${b.monthly_usd.toFixed(2)}/month` +
        (b.status ? ` (status ${b.status})` : "") +
        (b.period_end ? `, current period ends ${b.period_end}` : "") +
        (b.cancel_at_period_end ? ", cancels at period end" : "") +
        "."
    );
    if (b.pending_upgrade) {
      const p = b.pending_upgrade;
      lines.push(
        `Offer waiting (not applied): ${p.to_blocks} x ${b.block_gb} GB = ${p.new_quota_gb} GB for ` +
          `$${p.new_monthly_usd.toFixed(2)}/month. It takes effect ONLY if the human opens and agrees at ` +
          `${p.agree_url} (expires ${p.expires_at}). Do not describe it as done.`
      );
    } else {
      lines.push(
        "Plan size never changes from this tool. Near the top of the tier Obsideo emails an " +
          "agree link; the human's click is the only thing that changes the bill."
      );
    }
  }
  if (cfg.trial) {
    lines.push(
      "This account is a no-email trial. Claiming it with an email (signup_start) is free and " +
        "keeps the same account and data; it can be done before or after paying."
    );
  }
  return lines.join("\n");
}

export async function plan(): Promise<string> {
  const b = (await authed("GET", "/v1/billing")) as PlanStatus;
  return describePlan(b);
}

export async function upgrade(blocks = 1): Promise<string> {
  if (!Number.isInteger(blocks) || blocks < 1) throw new Error("blocks must be a whole number >= 1");
  try {
    const r = await authed("POST", "/v1/billing/checkout", { blocks });
    const gb = Number(r.block_gb) * blocks;
    return (
      `Checkout link for ${blocks} x ${r.block_gb} GB = ${gb.toFixed(1)} GB at ` +
      `$${Number(r.monthly_usd).toFixed(2)}/month:\n${r.url}\n\n` +
      "Nothing has been charged. Give this link to the human; they pay on Stripe's page " +
      "(card, monthly, cancel any time). The quota rises within about a minute of payment; " +
      "check with `plan` or `usage`. Do not open or submit the link on their behalf."
    );
  } catch (e) {
    if (isDisabled(e)) return DISABLED_MSG;
    if (e instanceof BillingHttpError && e.status === 409 && e.detail?.error === "subscription_exists") {
      const b = (await authed("GET", "/v1/billing")) as PlanStatus;
      return (
        "This account already has a paid plan; this tool never changes an existing plan's size.\n" +
        describePlan(b) +
        "\nTo cancel or change the card, call `portal`."
      );
    }
    throw e;
  }
}

export async function portal(): Promise<string> {
  try {
    const r = await authed("POST", "/v1/billing/portal");
    return (
      `Billing portal (cancel, change card, invoices):\n${r.url}\n\n` +
      "For the human to open. Cancelling keeps reads open; the account drops back to its free " +
      "quota at the end of the paid period, and nothing already stored is deleted by cancelling."
    );
  } catch (e) {
    if (isDisabled(e)) return DISABLED_MSG;
    if (e instanceof BillingHttpError && e.status === 409) {
      return "No paid plan on this account yet, so there is no portal. Call `upgrade` first.";
    }
    throw e;
  }
}
