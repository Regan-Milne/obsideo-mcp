/**
 * Self-serve signup against signup.obsideo.io — email OTP only, no card.
 *
 * The Ed25519 account signing keypair is generated HERE, on the user's
 * machine; only the public half is ever sent. The private key is written
 * to ~/.obsideo/signing.pem.
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { CONFIG_DIR, SIGNING_KEY_PATH, loadConfig, saveConfig } from "./config.js";

const SIGNUP_BASE = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";

async function post(path: string, body: unknown): Promise<any> {
  const resp = await fetch(SIGNUP_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Signup service returned ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    // The shim's refusals are labeled (placeholder_email, rate_limited with
    // retry_after_seconds, disposable_email_not_supported...). Pass the
    // label through verbatim so the calling agent can act on it.
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json.detail ?? json)}`);
  }
  return json;
}

export async function signupStart(email: string, source?: string): Promise<string> {
  const r = await post("/v1/auth/start", { email, source: source ?? "mcp" });
  return r.message ?? "Verification code sent. Check the inbox (and spam).";
}

function generateSigningKey(): string {
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
  const pubkey = generateSigningKey();
  const r = await post("/v1/auth/verify", {
    email,
    code,
    customer_signing_public_key: pubkey,
  });
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    email,
    account_id: r.account_id,
    account_token: r.account_token,
    endpoint: r.endpoint,
    region: r.region,
    bucket: r.bucket,
    access_key: r.access_key,
    secret_key: r.secret_key,
  });
  const fresh = r.account_exists
    ? "Existing account for this email: same account and quota, fresh credentials issued (prior ones revoked)."
    : "New account created.";
  return (
    `${fresh} Quota ${r.quota_gb} GB. Credentials and the account signing key were saved ` +
    `locally under ${CONFIG_DIR} (never share the secret key or signing.pem). ` +
    "Fresh credentials go live on the gateway within about 30 seconds; a 403 before " +
    "that is credentials_propagating: wait 15 s and retry, do not re-run signup."
  );
}
