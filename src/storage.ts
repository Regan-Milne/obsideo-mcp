/**
 * Storage operations against the Obsideo S3 gateway (external mode: the
 * gateway is a zero-knowledge passthrough; bytes are stored exactly as
 * sent). Optional encrypt-first via crypto.ts.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig, requireCreds, type ObsideoConfig } from "./config.js";
import { decrypt, encrypt, generateKey, isEncrypted } from "./crypto.js";

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
  encrypt?: boolean;
}

export async function put(args: PutArgs): Promise<string> {
  const cfg = loadConfig();
  requireCreds(cfg);
  let data: Buffer;
  if (args.local_path) data = readFileSync(args.local_path);
  else if (args.content !== undefined) data = Buffer.from(args.content, "utf8");
  else throw new Error("Provide either local_path or content.");
  if (data.length === 0) {
    throw new Error(
      "Zero-byte objects are rejected by the gateway (no folder markers). Send real content."
    );
  }
  let note = "";
  if (args.encrypt) {
    if (!cfg.encryption_key) {
      cfg.encryption_key = generateKey();
      saveConfig(cfg);
      note =
        " A new local AES-256-GCM key was generated and saved to your config; " +
        "back it up: key loss means these objects are unrecoverable.";
    }
    data = encrypt(data, cfg.encryption_key);
  }
  const c = client(cfg);
  await withBucket(cfg, () =>
    c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: args.key, Body: data }))
  );
  return (
    `Stored ${args.key} (${data.length} bytes${args.encrypt ? ", encrypted client-side" : ", bytes-as-sent"}).` +
    note
  );
}

export interface GetResult {
  text?: string;
  saved_to?: string;
  bytes: number;
  encrypted: boolean;
}

export async function get(key: string, local_path?: string): Promise<GetResult> {
  const cfg = loadConfig();
  requireCreds(cfg);
  const r = await client(cfg).send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
  );
  let data: Buffer = Buffer.from(await r.Body!.transformToByteArray()) as Buffer;
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
    writeFileSync(local_path, data);
    return { saved_to: local_path, bytes: data.length, encrypted: wasEncrypted };
  }
  if (data.length > 262144) {
    throw new Error(
      `Object is ${data.length} bytes; too large to return inline. Pass local_path to save it to disk.`
    );
  }
  return { text: data.toString("utf8"), bytes: data.length, encrypted: wasEncrypted };
}

export async function ls(prefix?: string): Promise<string> {
  const cfg = loadConfig();
  requireCreds(cfg);
  const r = await client(cfg).send(
    new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix })
  );
  const items = (r.Contents ?? []).map((o) => `${o.Size}\t${o.Key}`);
  return items.length ? items.join("\n") : "(no objects" + (prefix ? ` under ${prefix})` : ")");
}

export async function rm(key: string): Promise<string> {
  const cfg = loadConfig();
  requireCreds(cfg);
  await client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return `Deleted ${key}.`;
}

export async function usage(): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.account_token) {
    throw new Error(
      "No account token in config (usage requires an account created via signup tools)."
    );
  }
  const base = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";
  const resp = await fetch(base + "/v1/account/usage", {
    headers: { Authorization: `Bearer ${cfg.account_token}` },
  });
  const json: any = await resp.json();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json.detail ?? json)}`);
  return (
    `Used ${(json.used_bytes / 1e9).toFixed(3)} GB of ${json.quota_gb} GB ` +
    `(${(json.percent_used * 100).toFixed(1)}%). Account ${json.account_id}.`
  );
}
