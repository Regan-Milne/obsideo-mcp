/**
 * Self-serve signup against signup.obsideo.io — email OTP only, no card.
 *
 * Two flows share the same two tools:
 *   - CLAIM (default when a no-email trial is configured): the trial is
 *     promoted to the 12 GB tier IN PLACE. Same account id, bucket, keys and
 *     data; only the quota and the identity change. Authenticated by the
 *     trial's own account token.
 *   - AUTH (no account configured, or `abandon_trial`): a fresh account for
 *     that email. The Ed25519 account signing keypair is generated HERE, on
 *     the user's machine; only the public half is ever sent. The private key
 *     is written to ~/.obsideo/signing.pem.
 */

import { fetchOnce } from "./net.js";
import { generateKey } from "./crypto.js";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { CONFIG_DIR, SIGNING_KEY_PATH, defaultSource, loadConfig, saveConfig } from "./config.js";

const SIGNUP_BASE = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";

async function post(path: string, body: unknown, bearer?: string): Promise<any> {
  const resp = await fetchOnce(
    SIGNUP_BASE + path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    },
    { retry: false, timeoutMs: 90_000 }
  );
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Signup service returned ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    // The shim's refusals are labeled (placeholder_email, rate_limited with
    // retry_after_seconds, disposable_email, email_in_use...). Pass the
    // label through verbatim so the calling agent can act on it.
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json.detail ?? json)}`);
  }
  return json;
}

function claimable(): boolean {
  const cfg = loadConfig();
  return !!(cfg.trial && cfg.account_token);
}

export async function signupStart(
  email: string,
  source?: string,
  abandonTrial = false
): Promise<string> {
  const cfg = loadConfig();
  if (claimable() && !abandonTrial) {
    try {
      const r = await post("/v1/trial/claim/start", { email }, cfg.account_token);
      saveConfig({ ...loadConfig(), pending_signup_mode: "claim" });
      return (
        `Verification code sent to ${r.email ?? email}. Then call signup_verify with the code. ` +
        `This CLAIMS the current trial in place: ${r.keeps ?? "same account, bucket, keys and data; only the quota rises"}` +
        ` (to ${r.quota_after_gb ?? 12} GB).`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("email_in_use")) {
        throw new Error(
          msg +
            " That email already has its own Obsideo account, and a trial cannot be merged into it. " +
            "Either use a different email to claim this trial (keeps the trial's data), or call " +
            "signup_start again with abandon_trial=true to sign in to the existing account instead " +
            "(this trial's data stays on the trial account, which expires)."
        );
      }
      throw e;
    }
  }
  const r = await post("/v1/auth/start", { email, source: source ?? defaultSource() });
  saveConfig({ ...loadConfig(), pending_signup_mode: "auth" });
  return r.message ?? "Verification code sent. Check the inbox (and spam).";
}

export function generateSigningKey(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    SIGNING_KEY_PATH,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string
  );
  try {
    chmodSync(SIGNING_KEY_PATH, 0o600);
  } catch {
    /* windows */
  }
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = der.subarray(der.length - 32); // SPKI suffix = raw Ed25519 key
  return "obk_sig_" + raw.toString("base64url");
}

export async function signupVerify(email: string, code: string): Promise<string> {
  const cfg = loadConfig();
  const mode = cfg.pending_signup_mode ?? (claimable() ? "claim" : "auth");

  if (mode === "claim" && claimable()) {
    const r = await post("/v1/trial/claim/verify", { email, code }, cfg.account_token);
    const { pending_signup_mode: _drop, ...rest } = loadConfig();
    saveConfig({
      ...rest,
      email: r.email ?? email,
      trial: false,
      trial_expires_at: undefined,
    });
    const msg: string = r.message ?? "Claimed. Same account, same bucket, same keys; your data is untouched.";
    return (
      `${msg.startsWith("Claimed") ? "" : "Claimed. "}${msg} ` +
      `Quota is now ${r.quota_gb ?? 12} GB with no expiry. Credentials did not change, so nothing ` +
      "propagates and nothing needs re-uploading. Remind the human to back up ~/.obsideo/mcp.json."
    );
  }

  const pubkey = generateSigningKey();
  const r = await post("/v1/auth/verify", {
    email,
    code,
    customer_signing_public_key: pubkey,
  });
  const { pending_signup_mode: _drop, trial: _t, agent_name: _a, trial_expires_at: _e, ...rest } =
    loadConfig();
  saveConfig({
    ...rest,
    email,
    account_id: r.account_id,
    account_token: r.account_token,
    api_key: r.api_key,
    endpoint: r.endpoint,
    region: r.region,
    bucket: r.bucket,
    access_key: r.access_key,
    secret_key: r.secret_key,
    encryption_key: rest.encryption_key ?? generateKey(),
  });
  const fresh = r.account_exists
    ? "Existing account for this email: same account and quota, fresh credentials issued (prior ones revoked)."
    : "New account created.";
  return (
    `${fresh} Quota ${r.quota_gb} GB. Credentials, the account signing key and the encryption key were saved ` +
    `locally under ${CONFIG_DIR} (never share them; Obsideo has no copy of the encryption key). Call backup_keys now. ` +
    "Fresh credentials go live on the gateway within about 30 seconds; a 403 before " +
    "that is credentials_propagating: wait 15 s and retry, do not re-run signup."
  );
}
