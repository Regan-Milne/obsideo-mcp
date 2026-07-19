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
import { join } from "node:path";

export interface ObsideoConfig {
  email?: string;
  account_id?: string;
  account_token?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  access_key?: string;
  secret_key?: string;
  /** base64 32-byte AES-256-GCM key, generated locally on first encrypted put */
  encryption_key?: string;
}

export const CONFIG_DIR = process.env.OBSIDEO_MCP_HOME ?? join(homedir(), ".obsideo");
const CONFIG_PATH = join(CONFIG_DIR, "mcp.json");
export const SIGNING_KEY_PATH = join(CONFIG_DIR, "signing.pem");

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
