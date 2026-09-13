/**
 * Storage operations against the Obsideo S3 gateway (bytes are stored
 * exactly as sent). Optional encrypt-first via crypto.ts.
 */

import { fetchOnce } from "./net.js";
import { report } from "./progress.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync } from "node:fs";
import {
  saveConfig,
  requireCreds,
  recordRoot,
  expandPath,
  CONFIG_PATH,
  type ObsideoConfig,
} from "./config.js";
import { decrypt, encrypt, generateKey, isEncrypted } from "./crypto.js";
import { commitRoot } from "./verify.js";
import { commitment, deleteDirect, getDirect, listDirect, putDirect } from "./direct.js";
import { ensureCreds } from "./trial.js";

/**
 * Transport selection. "direct" = coordinator + providers (see direct.ts), the
 * default whenever the config carries a coordinator api_key, which every
 * self-serve signup does. "s3" = the gateway with SigV4 keys, kept for configs
 * that predate api_key and as an explicit escape hatch (OBSIDEO_TRANSPORT=s3).
 */
function transport(cfg: ObsideoConfig): "direct" | "s3" {
  const forced = (process.env.OBSIDEO_TRANSPORT ?? "").toLowerCase();
  if (forced === "s3" || forced === "direct") return forced;
  return cfg.api_key && cfg.account_id && cfg.bucket ? "direct" : "s3";
}
import { describePlan } from "./billing.js";

function client(cfg: ObsideoConfig): S3Client {
  requireCreds(cfg);
  const c = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key },
  });
  // The Obsideo gateway routes "/bucket/" (trailing slash, empty key) to the
  // object handler and 404s; strip it for bucket-level ops before signing.
  c.middlewareStack.add(
    (next) => async (args: any) => {
      const req = args.request;
      if (req?.path?.length > 1 && req.path.endsWith("/")) {
        req.path = req.path.slice(0, -1);
      }
      return next(args);
    },
    { step: "build" }
  );
  return c;
}

/**
 * A freshly minted keypair is registered with the COORDINATOR; the gateway
 * pulls that credential map on a ticker, so for one refresh interval after
 * provisioning the key is real but the gateway has not heard about it yet and
 * answers "unknown access key". The shim already burns ~15 s waiting this out
 * before it returns, and still loses the race sometimes.
 *
 * That window lands exactly on an agent's first put, which is the whole funnel.
 * So we wait it out here rather than handing back an error the agent cannot
 * interpret (Principle 4 — succeed gracefully). Budget is generous right after
 * provisioning and short otherwise, where the same error more likely means a
 * genuinely stale key.
 */
function isCredNotYetLive(e: any): boolean {
  const msg = String(e?.message ?? "");
  return (
    e?.name === "InvalidAccessKeyId" ||
    /unknown access key/i.test(msg) ||
    /InvalidAccessKeyId/i.test(msg)
  );
}

async function withCredPropagation<T>(justProvisioned: boolean, op: () => Promise<T>): Promise<T> {
  // 2,4,8,12,16,20,30 s => ~92 s of patience on a brand-new account.
  const backoffs = justProvisioned ? [2, 4, 8, 12, 16, 20, 30] : [3];
  let last: any;
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      if (!isCredNotYetLive(e) || i >= backoffs.length) {
        if (isCredNotYetLive(e)) {
          throw new Error(
            "The gateway still does not recognise these credentials. For a brand-new account " +
              "this is a propagation delay and retrying in a minute usually works; otherwise the " +
              "credentials in the local config are stale (re-run signup, or the trial expired)."
          );
        }
        throw e;
      }
      last = e;
      const left = backoffs.slice(i).reduce((a, b) => a + b, 0);
      await report(
        `Waiting for the gateway to accept the new credentials (attempt ${i + 1} of ${backoffs.length + 1}, up to ${left} s more)`,
        i + 1, backoffs.length + 1
      );
      await new Promise((r) => setTimeout(r, backoffs[i] * 1000));
    }
  }
  void last;
}

/** The gateway requires CreateBucket before first write (no implicit
 *  buckets); run op, auto-create the bucket on NoSuchBucket, retry once. */
async function withBucket<T>(cfg: ObsideoConfig, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e: any) {
    if (e?.name !== "NoSuchBucket") throw e;
    await client(cfg).send(new CreateBucketCommand({ Bucket: (cfg as any).bucket }));
    return await op();
  }
}

export interface PutArgs {
  key: string;
  local_path?: string;
  content?: string;
  /** Default TRUE. Pass false only for S3 interop, where another tool must
   *  read the stored bytes without our key. */
  encrypt?: boolean;
}

export async function put(args: PutArgs): Promise<string> {
  const { cfg, note: provisionNote, provisioned } = await ensureCreds();
  let data: Buffer;
  if (args.local_path) data = readFileSync(expandPath(args.local_path));
  else if (args.content !== undefined) data = Buffer.from(args.content, "utf8");
  else throw new Error("Provide either local_path or content.");
  if (data.length === 0) {
    throw new Error(
      "Zero-byte objects are rejected by the gateway (no folder markers). Send real content."
    );
  }
  // Encrypt by default (Reg 2026-08-12). Plaintext is an explicit opt-out for
  // S3 interop, never a silent default: the platform should not be able to
  // read the object unless the user deliberately chose that.
  const wantEncrypt = args.encrypt !== false;
  let note = "";
  if (wantEncrypt) {
    if (!cfg.encryption_key) {
      cfg.encryption_key = generateKey();
      saveConfig(cfg);
      note =
        ` IMPORTANT, tell your human: a new AES-256-GCM key was generated on this ` +
        `machine and saved to ${CONFIG_PATH}. It is the only copy and Obsideo does ` +
        `not have it. Back that file up now; if it is lost, every encrypted object ` +
        `is permanently unrecoverable, replication and proofs notwithstanding.`;
    }
    data = encrypt(data, cfg.encryption_key);
  }
  let root: string;
  let placement = "";
  if (transport(cfg) === "direct") {
    // No gateway, no S3 keys, no propagation wait: the coordinator that minted
    // the account is the party we talk to, and its api_key is valid at once.
    const c = commitment(data);
    const r = await putDirect(cfg, args.key, data, undefined, c);
    root = c.root;
    placement =
      r.providers < r.placed
        ? ` ${r.providers} of ${r.placed} providers accepted the bytes; the network backfills the rest.`
        : "";
  } else {
    const c = client(cfg);
    await withCredPropagation(provisioned, () =>
      withBucket(cfg, () =>
        c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: args.key, Body: data }))
      )
    );
    root = commitRoot(data);
  }
  // Record our own commitment to the uploaded bytes so `verify` can later prove
  // the providers hold exactly these bytes — including for encrypted objects,
  // whose ciphertext cannot be reproduced from the plaintext (fresh IV per put).
  recordRoot(cfg.bucket!, args.key, {
    root,
    encrypted: wantEncrypt,
    bytes: data.length,
    at: new Date().toISOString(),
  });
  return (
    provisionNote +
    `Stored ${args.key} (${data.length} bytes${
      wantEncrypt
        ? ", encrypted client-side before upload; the platform holds ciphertext it cannot read"
        : ", PLAINTEXT as sent (encryption explicitly disabled)"
    }).` +
    placement +
    note
  );
}

export interface GetResult {
  text?: string;
  saved_to?: string;
  bytes: number;
  encrypted: boolean;
  note?: string;
}

export async function get(key: string, local_path?: string): Promise<GetResult> {
  const { cfg, note, provisioned } = await ensureCreds();
  let data: Buffer;
  if (transport(cfg) === "direct") {
    data = await getDirect(cfg, key);
  } else {
    const r = await withCredPropagation(provisioned, () =>
      client(cfg).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
    );
    data = Buffer.from(await r.Body!.transformToByteArray()) as Buffer;
  }
  let wasEncrypted = false;
  if (isEncrypted(data)) {
    if (!cfg.encryption_key) {
      throw new Error(
        "Object is encrypted with a local key but no encryption_key is present in " +
          "your config. Restore your original ~/.obsideo/mcp.json to decrypt."
      );
    }
    data = decrypt(data, cfg.encryption_key);
    wasEncrypted = true;
  }
  if (local_path) {
    const target = expandPath(local_path);
    writeFileSync(target, data);
    return { saved_to: target, bytes: data.length, encrypted: wasEncrypted, note };
  }
  if (data.length > 262144) {
    throw new Error(
      `Object is ${data.length} bytes; too large to return inline. Pass local_path to save it to disk.`
    );
  }
  return { text: data.toString("utf8"), bytes: data.length, encrypted: wasEncrypted, note };
}

export async function ls(prefix?: string): Promise<string> {
  const { cfg, note, provisioned } = await ensureCreds();
  let items: string[];
  if (transport(cfg) === "direct") {
    items = (await listDirect(cfg, prefix)).map((o) => `${o.size_bytes}\t${o.key}`);
  } else {
    const r = await withCredPropagation(provisioned, () =>
      client(cfg).send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix }))
    );
    items = (r.Contents ?? []).map((o) => `${o.Size}\t${o.Key}`);
  }
  const body = items.length ? items.join("\n") : "(no objects" + (prefix ? ` under ${prefix})` : ")");
  return note + body;
}

export async function rm(key: string): Promise<string> {
  const { cfg, note, provisioned } = await ensureCreds();
  if (transport(cfg) === "direct") {
    await deleteDirect(cfg, key);
  } else {
    await withCredPropagation(provisioned, () =>
      client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    );
  }
  return note + `Deleted ${key}.`;
}

export async function usage(): Promise<string> {
  const { cfg, note } = await ensureCreds();
  const base = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";
  const resp = await fetchOnce(base + "/v1/account/usage", {
    headers: { Authorization: `Bearer ${cfg.account_token}` },
  });
  const json: any = await resp.json();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json.detail ?? json)}`);
  const billing = json.billing ? "\n" + describePlan(json.billing, cfg) : "";
  return (
    note +
    `Used ${(json.used_bytes / 1e9).toFixed(3)} GB of ${json.quota_gb} GB ` +
    `(${(json.percent_used * 100).toFixed(1)}%). Account ${json.account_id}.` +
    billing
  );
}
