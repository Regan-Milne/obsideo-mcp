/**
 * Direct transport: coordinator + providers, no S3 gateway.
 *
 * Why this exists (2026-09-12). Every account gets S3 credentials at signup,
 * and until now every MCP upload went through the S3 gateway with them. The
 * gateway learns new keys by polling the coordinator every 30 s, so for a
 * random 0-30 s after signup an agent's first put was refused with "unknown
 * access key" and the gateway's bucket-create step could fail outright. The
 * first outside trial (2026-09-12) got a working bucket on the signup shim's
 * seventh and last retry. `withCredPropagation` in storage.ts papers over
 * this with up to ~92 s of patience. That is a workaround, not a fix.
 *
 * The coordinator is the party that MINTS the account, and its bearer
 * `api_key` is valid the instant redeem returns. Talking to it directly, and
 * to the providers it names, removes the gateway hop, the second identity
 * system and the race. It is the same path this package already uses for
 * verification (verify.ts) and the same one the browser test page uses, so
 * nothing here is new protocol: register the object with the coordinator,
 * upload the bytes to each provider it names, confirm.
 *
 * Bytes are stored exactly as handed in (encryption stays in crypto.ts, ahead
 * of this layer), which is the coordinator's "external" encryption mode: the
 * mode every self-serve account is created in.
 *
 * Wire format mirrors @obsideo/sdk 0.5.x putObject/getObject; kept dependency
 * free on purpose, like verify.ts.
 */

import { createHash } from "node:crypto";
import type { ObsideoConfig } from "./config.js";

export const CHUNK_SIZE = 1048576; // the network's frozen 1 MiB chunk
const SINGLE_POST_MAX = 10 * 1024 * 1024; // above this, chunked transport
const TRANSPORT_CHUNK = 5 * 1024 * 1024;
const COORDINATOR = process.env.OBSIDEO_COORDINATOR_URL ?? "https://coordinator.obsideo.io";
const UA = "obsideo-mcp/direct";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sha3_512 = (b: Buffer) => createHash("sha3-512").update(b).digest();

/** Same tree as verify.ts and the SDK: leaf = sha3_512(sha256(index + hex(chunk))),
 *  zero-padded to a power of two, sha3_512 over concatenated pairs. */
export function commitment(data: Buffer): { root: string; chunkHashes: string[] } {
  const chunkHashes: string[] = [];
  const leaves: Buffer[] = [];
  for (let i = 0, off = 0; off < data.length; i++, off += CHUNK_SIZE) {
    const ch = sha256(
      Buffer.from(String(i) + data.subarray(off, Math.min(off + CHUNK_SIZE, data.length)).toString("hex"), "ascii")
    );
    chunkHashes.push(ch.toString("hex"));
    leaves.push(sha3_512(ch));
  }
  if (leaves.length === 0) throw new Error("no leaves");
  let size = 1;
  while (size < leaves.length) size *= 2;
  let level = leaves.slice();
  while (level.length < size) level.push(Buffer.alloc(64));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha3_512(Buffer.concat([level[i], level[i + 1]])));
    level = next;
  }
  return { root: level[0].toString("hex"), chunkHashes };
}

function requireDirect(cfg: ObsideoConfig): { apiKey: string; accountId: string; bucket: string } {
  if (!cfg.api_key || !cfg.account_id || !cfg.bucket) {
    throw new Error(
      "Direct transport needs api_key, account_id and bucket in the local config. " +
        "Re-run signup, or set OBSIDEO_TRANSPORT=s3 to use the gateway with S3 keys."
    );
  }
  return { apiKey: cfg.api_key, accountId: cfg.account_id, bucket: cfg.bucket };
}

async function coord(cfg: ObsideoConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const { apiKey } = requireDirect(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": UA,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(COORDINATOR + path, { ...init, headers });
}

async function fail(what: string, res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? msg;
  } catch {
    /* not json */
  }
  if (res.status === 402) {
    throw new Error(`${what}: quota or plan limit (402). ${msg}`);
  }
  if (res.status === 403 && /suspend/i.test(String(msg))) {
    throw new Error(`${what}: account suspended (403). ${msg}`);
  }
  throw new Error(`${what}: HTTP ${res.status}. ${msg}`);
}

const enc = encodeURIComponent;

/** Idempotent: the coordinator answers 2xx for created and 409 for exists. */
export async function ensureBucket(cfg: ObsideoConfig): Promise<void> {
  const { bucket } = requireDirect(cfg);
  const res = await coord(cfg, `/v1/buckets/${enc(bucket)}`, { method: "PUT" });
  if (res.ok || res.status === 409) {
    await res.text().catch(() => "");
    return;
  }
  await fail("create bucket", res);
}

interface ProviderUpload {
  provider_id: string;
  address: string;
  upload_token: string;
}

async function providerRequest(url: string, init: RequestInit, what: string): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} (${res.status}): ${text.slice(0, 200)}`);
  }
  await res.text().catch(() => "");
}

async function uploadSingle(p: ProviderUpload, root: string, data: Buffer): Promise<void> {
  const url = `${p.address}/upload/${root}?owner=mcp&start=0&chunk_size=${CHUNK_SIZE}&proof_type=0`;
  await providerRequest(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.upload_token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
        "User-Agent": UA,
      },
      body: new Uint8Array(data),
    },
    "provider upload failed"
  );
}

async function uploadChunked(p: ProviderUpload, root: string, data: Buffer): Promise<void> {
  const total = Math.ceil(data.length / TRANSPORT_CHUNK);
  for (let i = 0; i < total; i++) {
    const chunk = data.subarray(i * TRANSPORT_CHUNK, Math.min((i + 1) * TRANSPORT_CHUNK, data.length));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await providerRequest(
          `${p.address}/upload/${root}/chunk?index=${i}&total=${total}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${p.upload_token}`,
              "Content-Type": "application/octet-stream",
              "Content-Length": String(chunk.length),
              "User-Agent": UA,
            },
            body: new Uint8Array(chunk),
          },
          `chunk ${i + 1}/${total} failed`
        );
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
  }
  await providerRequest(
    `${p.address}/upload/${root}/finalize?owner=mcp&chunk_size=${CHUNK_SIZE}&proof_type=0`,
    { method: "POST", headers: { Authorization: `Bearer ${p.upload_token}`, "User-Agent": UA } },
    "finalize failed"
  );
}

export interface DirectPutResult {
  root: string;
  providers: number; // accepted
  placed: number; // named by the coordinator
}

/**
 * register -> upload to every named provider (in parallel) -> confirm.
 * Partial acceptance is reported, not hidden: the coordinator's replicator
 * backfills to RF from whichever providers took the bytes (Principle 4).
 */
export async function putDirect(
  cfg: ObsideoConfig,
  key: string,
  data: Buffer,
  contentType = "application/octet-stream",
  precomputed?: { root: string; chunkHashes: string[] }
): Promise<DirectPutResult> {
  const { accountId, bucket } = requireDirect(cfg);
  if (data.length === 0) throw new Error("Zero-byte objects are rejected (no folder markers). Send real content.");
  const { root, chunkHashes } = precomputed ?? commitment(data);

  const register = async () =>
    coord(cfg, `/v1/buckets/${enc(bucket)}/objects/${enc(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merkle_root: root,
        size_bytes: data.length,
        chunk_count: chunkHashes.length,
        chunk_size: CHUNK_SIZE,
        chunk_hashes: chunkHashes,
        content_type: contentType,
        encrypt: false,
        wrapped_key: "",
        encryption: "external",
      }),
    });

  let regRes = await register();
  if (regRes.status === 404) {
    // Bucket missing: the signup shim creates it, but that step is best effort.
    await regRes.text().catch(() => "");
    await ensureBucket(cfg);
    regRes = await register();
  }
  if (!regRes.ok) await fail("register object", regRes);
  const reg = (await regRes.json()) as { merkle_root: string; providers: ProviderUpload[] };
  if (!reg.providers?.length) throw new Error("register object: coordinator named no providers");

  const results = await Promise.allSettled(
    reg.providers.map((p) => (data.length > SINGLE_POST_MAX ? uploadChunked(p, root, data) : uploadSingle(p, root, data)))
  );
  const accepted: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") accepted.push(reg.providers[i].provider_id);
    else failed.push(`${reg.providers[i].provider_id}: ${String((r as PromiseRejectedResult).reason?.message ?? r)}`);
  });
  if (accepted.length === 0) {
    throw new Error(`upload failed: all ${reg.providers.length} providers rejected the bytes (${failed.join("; ")})`);
  }

  const confirmRes = await coord(cfg, `/internal/uploads/${root}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: accountId, bucket, key, providers: accepted, ack: true }),
  });
  if (!confirmRes.ok) await fail("confirm upload", confirmRes);
  await confirmRes.text().catch(() => "");
  return { root, providers: accepted.length, placed: reg.providers.length };
}

export async function getDirect(cfg: ObsideoConfig, key: string): Promise<Buffer> {
  const { bucket } = requireDirect(cfg);
  const metaRes = await coord(cfg, `/v1/buckets/${enc(bucket)}/objects/${enc(key)}`);
  if (metaRes.status === 404) throw new Error(`Object not found: ${key}`);
  if (!metaRes.ok) await fail("get object", metaRes);
  const meta = (await metaRes.json()) as { merkle_root: string; provider_url: string; download_token: string };
  const dl = await fetch(`${meta.provider_url}/download/${meta.merkle_root}`, {
    headers: { Authorization: `Bearer ${meta.download_token}`, "User-Agent": UA },
  });
  if (!dl.ok) throw new Error(`provider download failed (${dl.status})`);
  return Buffer.from(new Uint8Array(await dl.arrayBuffer()));
}

export interface DirectObject {
  key: string;
  size_bytes: number;
  proof_status?: string;
}

export async function listDirect(cfg: ObsideoConfig, prefix?: string): Promise<DirectObject[]> {
  const { bucket } = requireDirect(cfg);
  const path = `/v1/buckets/${enc(bucket)}/objects` + (prefix ? `?prefix=${enc(prefix)}` : "");
  const res = await coord(cfg, path);
  if (res.status === 404) return []; // bucket not created yet == nothing stored
  if (!res.ok) await fail("list objects", res);
  const body = (await res.json()) as { objects?: DirectObject[] };
  return body.objects ?? [];
}

/** Unlinks the key; physical erase follows the network's GC/retention rules,
 *  exactly as when the gateway issued this same call on the agent's behalf. */
export async function deleteDirect(cfg: ObsideoConfig, key: string): Promise<void> {
  const { bucket } = requireDirect(cfg);
  const res = await coord(cfg, `/v1/buckets/${enc(bucket)}/objects/${enc(key)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204 && res.status !== 404) await fail("delete object", res);
  await res.text().catch(() => "");
}
