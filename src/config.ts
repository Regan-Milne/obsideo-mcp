/**
 * Local credential/config store — ~/.obsideo/mcp.json (created 0600).
 *
 * P1 posture: this server runs on the USER'S machine. Credentials, the
 * account signing key, and the optional encryption key live here and are
 * never sent anywhere except the S3 endpoint they authenticate against.
 * Obsideo never hosts this server and never sees these files.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Agents pass "~/x" and "$HOME/x" constantly and Node expands neither; the
 * first Hermes run on 2026-09-11 died on exactly that. Used for every
 * user-supplied local path (put, get, verify).
 */
export function expandPath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(home, p.slice(2));
  if (p.startsWith("$HOME/")) return resolve(home, p.slice(6));
  if (p.startsWith("%USERPROFILE%")) return resolve(home, p.slice(13).replace(/^[\\/]/, ""));
  return resolve(p);
}

export interface ObsideoConfig {
  email?: string;
  account_id?: string;
  account_token?: string;
  /** coordinator bearer (obs_...): authorizes the verification-kit + proof-status APIs */
  api_key?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  access_key?: string;
  secret_key?: string;
  /** base64 32-byte AES-256-GCM key, generated locally on first encrypted put */
  encryption_key?: string;
  /** true when this account was auto-provisioned as a no-email trial */
  trial?: boolean;
  /** generated reference handle for a trial account, e.g. "copper-badger" */
  agent_name?: string;
  /** ISO expiry of a trial account (informational) */
  trial_expires_at?: string;
  /** which signup flow signup_start began, so signup_verify finishes the same one */
  pending_signup_mode?: "claim" | "auth";
}

export const CONFIG_DIR = process.env.OBSIDEO_MCP_HOME ?? join(homedir(), ".obsideo");
export const CONFIG_PATH = join(CONFIG_DIR, "mcp.json");
export const SIGNING_KEY_PATH = join(CONFIG_DIR, "signing.pem");
const ROOTS_PATH = join(CONFIG_DIR, "roots.json");

/** Keep the newest N commitments; trimming beats an unbounded file. */
const ROOTS_MAX = 2000;

export interface RootRecord {
  /** merkle root of the bytes that were actually uploaded */
  root: string;
  /** true when those bytes were ciphertext (encrypted client-side before upload) */
  encrypted: boolean;
  bytes: number;
  at: string;
}

export function loadConfig(): ObsideoConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(cfg: ObsideoConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows: chmod is a no-op; the file inherits the user profile ACL.
  }
}

/**
 * Local record of what we committed at upload time.
 *
 * Encryption is non-deterministic (fresh IV per put), so ciphertext cannot be
 * reproduced from the plaintext later. Without this, `verify` could never prove
 * "they hold MY bytes" for an encrypted object. This file is the user's own
 * commitment, computed on their machine from their own bytes, so verifying
 * against it does not depend on the coordinator's word about what was stored.
 * (The coordinator still lists which providers hold it and their public keys,
 * which affects who is named as holding a copy, not whether a copy is held.)
 */
function loadRoots(): Record<string, RootRecord> {
  if (!existsSync(ROOTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ROOTS_PATH, "utf8"));
  } catch {
    return {}; // a corrupt cache must never block storage
  }
}

export function recordRoot(bucket: string, key: string, rec: RootRecord): void {
  const roots = loadRoots();
  roots[`${bucket}/${key}`] = rec;
  const keys = Object.keys(roots);
  if (keys.length > ROOTS_MAX) {
    keys
      .sort((a, b) => (roots[a].at < roots[b].at ? -1 : 1))
      .slice(0, keys.length - ROOTS_MAX)
      .forEach((k) => delete roots[k]);
  }
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(ROOTS_PATH, JSON.stringify(roots, null, 2) + "\n");
  } catch {
    // Best-effort: failing to cache a root must never fail the upload.
  }
}

export function lookupRoot(bucket: string, key: string): RootRecord | undefined {
  return loadRoots()[`${bucket}/${key}`];
}

export function requireCreds(cfg: ObsideoConfig): asserts cfg is Required<
  Pick<ObsideoConfig, "endpoint" | "bucket" | "access_key" | "secret_key">
> & ObsideoConfig {
  if (!cfg.access_key || !cfg.secret_key || !cfg.endpoint || !cfg.bucket) {
    throw new Error(
      "No Obsideo credentials configured. Run the signup_start tool (then signup_verify " +
        "with the emailed code) to create a free account, or place existing credentials " +
        `in ${CONFIG_PATH}.`
    );
  }
}

/**
 * The channel label this install reports at signup.
 *
 * Defaults to "mcp". Our own end-to-end runs set OBSIDEO_SOURCE=verify so they
 * declare themselves as ours at the moment the account is created, instead of
 * being scrubbed out of the funnel afterwards by hand.
 *
 * Why it matters: an e2e run auto-provisions exactly like a real customer's
 * first `put` -- same path, same default source. On 2026-09-12 that made the
 * signup alert email announce our own test as a customer conversion, and put
 * twenty of our own accounts into a cumulative funnel count of twenty-two. No
 * downstream filter can separate them once they are identical on the wire, so
 * the separation has to happen here.
 */
let clientName = "";
/** Set once from the MCP initialize handshake (clientInfo.name). */
export function setClientName(name: string): void {
  clientName = (name ?? "").trim();
}
export function clientNameForTests(): string {
  return clientName;
}
export function defaultSource(): string {
  const env = (process.env.OBSIDEO_SOURCE ?? "").trim();
  if (env) return env;
  // Hermes Agent identifies itself as "hermes" / "hermes-agent" in
  // clientInfo.name; a catalog install has no other way to tell us it is one.
  if (/hermes/i.test(clientName)) return "hermes";
  return "mcp";
}
