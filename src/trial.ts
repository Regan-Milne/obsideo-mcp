/**
 * No-email trial provisioning.
 *
 * The email-OTP wall is unclimbable for an agent with no inbox access. The
 * trial path swaps identity for a little friction: a server-enforced ~10 s
 * wait plus a small proof-of-work, in exchange for a real account on the
 * production network (100 MB, ~7 days, RF=3, same possession proofs). This
 * module is what makes `npx obsideo-mcp` work on first use with zero setup:
 * the first storage call auto-provisions a trial and continues, so an agent
 * never sees a signup step.
 *
 * The Ed25519 signing keypair is generated locally (only the public half is
 * sent); credentials land in ~/.obsideo/mcp.json exactly like the email flow.
 */

import { fetchOnce } from "./net.js";
import { report, sleepWithCountdown } from "./progress.js";
import { generateKey } from "./crypto.js";
import { createHash } from "node:crypto";
import { generateSigningKey } from "./signup.js";
import { defaultSource, loadConfig, saveConfig, type ObsideoConfig } from "./config.js";

const SIGNUP_BASE = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";

// Opt out of the frictionless first-use trial. Set to require an explicit
// account (signup tools or a hand-placed config) before any storage op.
const AUTO_TRIAL_DISABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OBSIDEO_NO_AUTO_TRIAL ?? "").toLowerCase()
);

async function post(path: string, body: unknown): Promise<any> {
  const resp = await fetchOnce(
    SIGNUP_BASE + path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    // redeem provisions the account and waits for the gateway; it is not idempotent
    { retry: path.endsWith("/start"), timeoutMs: path.endsWith("/redeem") ? 120_000 : 30_000 }
  );
  const raw = await resp.text();
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Trial service returned ${resp.status}: ${raw.slice(0, 300)}`);
  }
  if (!resp.ok) {
    // Labeled refusals (trial_pool_full, rate_limited, pow_invalid...) pass
    // through verbatim so the caller can act on them.
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json.detail ?? json)}`);
  }
  return json;
}

/** Leading-zero-BITS check, byte-exact with the shim's verifier. */
function powOk(challenge: string, nonce: string, bits: number): boolean {
  const d = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  let rem = bits;
  for (const byte of d) {
    if (rem <= 0) return true;
    if (rem >= 8) {
      if (byte !== 0) return false;
      rem -= 8;
    } else {
      return byte >> (8 - rem) === 0;
    }
  }
  return rem <= 0;
}

/** Find a nonce satisfying `bits` leading zero bits. At 20 bits this is ~1M
 *  sha256 hashes, well under a second in Node. The uint32 fast path covers
 *  bits <= 32 (all the shim will ever ask); a byte-loop fallback keeps it
 *  correct if that ever grows. */
export function solvePow(challenge: string, bits: number): string {
  if (bits <= 32) {
    const shift = 32 - bits;
    for (let i = 0; ; i++) {
      const nonce = String(i);
      const d = createHash("sha256").update(`${challenge}:${nonce}`).digest();
      if (d.readUInt32BE(0) >>> shift === 0) return nonce;
    }
  }
  for (let i = 0; ; i++) {
    const nonce = String(i);
    if (powOk(challenge, nonce, bits)) return nonce;
  }
}

export interface TrialResult {
  agent_name: string;
  quota_mb: number;
  expires_at?: string;
}

/**
 * Full trial flow: start -> solve PoW -> wait out the server clock -> redeem.
 * Saves the credentials to the local config (merging over any existing) and
 * returns the human-facing summary. Throws with the shim's labeled error on
 * pool-full / rate-limit / disabled.
 */
/**
 * Refuse to replace a working account by accident. The 2026-09-11 Hermes run
 * called `trial` on a machine that already had a claimed 12 GB account and
 * silently swapped its credentials and signing key for a fresh 100 MB trial.
 * Explicit replacement stays possible; accidental replacement does not.
 */
export function refuseIfConfigured(replace: boolean): void {
  const cfg = loadConfig();
  if (replace || !(cfg.access_key && cfg.account_token)) return;
  throw new Error(
    `An Obsideo account is already configured on this machine (${cfg.account_id ?? "unknown"}, ` +
      `${cfg.trial ? "trial" : cfg.email ?? "claimed"}). Creating a trial now would REPLACE its ` +
      "credentials and signing key in the local config. Use the existing account (call `usage`), " +
      "or pass replace=true only if the human explicitly wants a fresh, separate account."
  );
}

export async function provisionTrial(source = defaultSource()): Promise<TrialResult> {
  await report("Creating a free Obsideo trial account: requesting an issuance ticket", 1, 5);
  const start = await post("/v1/trial/start", { source });
  const t0 = Date.now();
  await report("Solving the proof of work (a second or two)", 2, 5);
  const nonce = solvePow(start.pow_challenge, start.pow_bits);
  // The shim enforces min_wait_seconds server-side; sleep out whatever the
  // PoW did not already cover (+250 ms slack for clock skew).
  const waited = (Date.now() - t0) / 1000;
  const remaining = (start.min_wait_seconds ?? 10) - waited;
  if (remaining > 0) await sleepWithCountdown(remaining * 1000 + 250, "Waiting out the issuance window");

  await report("Registering the account and its signing key", 4, 5);
  const pubkey = generateSigningKey();
  // Declare the transport. "direct" lets the signup service return at once
  // instead of waiting up to ~30 s for the S3 gateway to learn the new key
  // (we never use the gateway on that path; storage.ts picks direct whenever
  // api_key is present). Forcing OBSIDEO_TRANSPORT=s3 keeps the old, slower,
  // bucket-ready-on-return behaviour.
  const transport = (process.env.OBSIDEO_TRANSPORT ?? "").toLowerCase() === "s3" ? "s3" : "direct";
  const r = await post("/v1/trial/redeem", {
    ticket: start.ticket,
    nonce,
    customer_signing_public_key: pubkey,
    source,
    transport,
  });

  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    email: `trial:${r.agent_name}`,
    account_id: r.account_id,
    account_token: r.account_token,
    api_key: r.api_key,
    endpoint: r.endpoint,
    region: r.region,
    bucket: r.bucket,
    access_key: r.access_key,
    secret_key: r.secret_key,
    trial: true,
    agent_name: r.agent_name,
    trial_expires_at: r.trial?.expires_at,
    // The encryption key is born WITH the account, so a backup taken right
    // after signup is complete. (Before 0.6.4 it appeared on the first put,
    // and an evaluator's post-signup backup was useless as a result.)
    encryption_key: cfg.encryption_key ?? generateKey(),
  });
  await report("Account ready", 5, 5);
  return { agent_name: r.agent_name, quota_mb: r.quota_mb, expires_at: r.trial?.expires_at };
}

/**
 * Return a config that has working credentials, provisioning a trial on the
 * fly if there are none (and auto-trial is not disabled). `note` is a short
 * transparency line to prepend to the calling tool's result the first time a
 * trial is created, so the agent can relay it to its human; it is empty when
 * credentials already existed.
 */
export async function ensureCreds(
  source = defaultSource()
): Promise<{ cfg: ObsideoConfig; note: string; provisioned: boolean }> {
  const cfg = loadConfig();
  const haveCreds = cfg.access_key && cfg.secret_key && cfg.endpoint && cfg.bucket;
  if (haveCreds) return { cfg, note: "", provisioned: false };

  if (AUTO_TRIAL_DISABLED) {
    throw new Error(
      "No Obsideo credentials configured and auto-trial is disabled " +
        "(OBSIDEO_NO_AUTO_TRIAL). Run signup_start + signup_verify for the 12 GB " +
        "email tier, or unset OBSIDEO_NO_AUTO_TRIAL to auto-create a free trial."
    );
  }

  const t = await provisionTrial(source);
  const note =
    `No account was configured, so a free no-email trial was created: agent "${t.agent_name}", ` +
    `${t.quota_mb} MB, expires ${t.expires_at ?? "in ~7 days"}. It lives on the production ` +
    `network with RF=3 replication and continuous possession proofs. Tell your human: this is a ` +
    `trial (small and temporary); to keep the data, claim it with an email via signup_start ` +
    `(12 GB free, no card, no expiry; same account, nothing moves). Credentials AND the encryption ` +
    `key were saved locally under ~/.obsideo; Obsideo has no copy of the key. Call backup_keys now ` +
    `with a path the human names.\n\n`;
  return { cfg: loadConfig(), note, provisioned: true };
}
