/**
 * Client-side proof of retrievability (kickoff_trial_key_funnel / note_sigea_por_test).
 *
 * Answers the one question that made a blind agent treat us as secondary-only:
 * "can I actually verify the durability claim myself?" Yes. This challenges
 * every provider holding an object DIRECTLY, recomputes the merkle root from
 * YOUR bytes, and checks each provider's Ed25519 signature. Nothing the
 * coordinator says is trusted for the verdict — it is only asked WHERE to go.
 *
 * Ported from the zero-dependency reference verifier (coordinator/proof/
 * reference-verifier/verify.js) that a production customer (Sigea) already ran
 * successfully against the live network. Wire format: coordinator/proof/FORMAT.md.
 */

import { createHash, createPublicKey, verify as edVerify, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

const CHUNK_SIZE = 1048576; // 1 MiB, frozen network-wide
const SIG_DOMAIN = "obsideo-proof-response-v1";
const COORDINATOR = process.env.OBSIDEO_COORDINATOR_URL ?? "https://coordinator.obsideo.io";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sha3_512 = (b: Buffer) => createHash("sha3-512").update(b).digest();

/** chunk_hash[i] = SHA-256( decimal(i) || lowercase_hex(bytes) ), both ASCII. */
function chunkHash(index: number, bytes: Buffer): Buffer {
  return sha256(Buffer.from(String(index) + bytes.toString("hex"), "ascii"));
}

/** Zero-padded arity-2 SHA3-512 tree. A single leaf IS the root. */
function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new Error("no leaves");
  if (leaves.length === 1) return leaves[0];
  let size = 1;
  while (size < leaves.length) size *= 2;
  let level = leaves.slice();
  while (level.length < size) level.push(Buffer.alloc(64));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha3_512(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}

interface Commitment {
  root: string;
  chunkHashes: string[] | null;
  chunkCount: number;
}

function commit(data: Buffer): Commitment {
  const chunkHashes: string[] = [];
  const leaves: Buffer[] = [];
  for (let i = 0, off = 0; off < data.length; i++, off += CHUNK_SIZE) {
    const ch = chunkHash(i, data.subarray(off, Math.min(off + CHUNK_SIZE, data.length)));
    chunkHashes.push(ch.toString("hex"));
    leaves.push(sha3_512(ch));
  }
  return { root: merkleRoot(leaves).toString("hex"), chunkHashes, chunkCount: chunkHashes.length };
}

function walkProof(leaf: Buffer, siblings: string[], index: number): Buffer {
  let cur = leaf;
  let idx = index;
  for (const sibHex of siblings) {
    const sib = Buffer.from(sibHex, "hex");
    cur = sha3_512(idx % 2 === 0 ? Buffer.concat([cur, sib]) : Buffer.concat([sib, cur]));
    idx = Math.floor(idx / 2);
  }
  return cur;
}

function sigPayload(r: any, blockIndex: number, rawChunk: Buffer): Buffer {
  return Buffer.from(
    [
      SIG_DOMAIN, r.provider_id, r.challenge_id, r.nonce, r.merkle_root,
      String(r.chunk_index), String(blockIndex), String(r.proof_version),
      sha256(rawChunk).toString("hex"),
    ].join("\n"),
    "utf8"
  );
}

function verifyEd25519(rawPubHex: string, message: Buffer, sigB64: string): boolean {
  const raw = Buffer.from(rawPubHex, "hex");
  if (raw.length !== 32) return false;
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 64) return false;
  return edVerify(null, message, key, sig);
}

/** Every check from FORMAT.md §5, in order. */
function verifyResponse(challenge: any, response: any, commitment: Commitment, pubkeyHex: string | null) {
  const fail = () => ({ pass: false, integrity: false, signed: false });
  if (response.challenge_id !== challenge.challenge_id) return fail();
  if (response.nonce !== challenge.nonce) return fail();
  if (Math.floor(Date.now() / 1000) > challenge.expires_at) return fail();
  if (response.merkle_root !== challenge.merkle_root) return fail();
  if (response.chunk_index !== challenge.chunk_index) return fail();
  if (!(challenge.chunk_index >= 0 && challenge.chunk_index < commitment.chunkCount)) return fail();

  const raw = Buffer.from(response.chunk_data || "", "base64");
  if (raw.length === 0) return fail();

  const ch = chunkHash(response.chunk_index, raw);
  if (commitment.chunkHashes) {
    if (ch.toString("hex") !== commitment.chunkHashes[response.chunk_index]) return fail();
  }
  const computed = walkProof(sha3_512(ch), response.merkle_proof.siblings, response.merkle_proof.index);
  if (computed.toString("hex") !== commitment.root) return fail();

  // Authenticity. A missing signature from a provider we hold a key for is a
  // downgrade attack, not a limitation — treat it as failure.
  if (!response.signature) {
    return { pass: !pubkeyHex, integrity: true, signed: false };
  }
  if (!pubkeyHex) return { pass: true, integrity: true, signed: false };
  const blockIndex = response.proof_version === 4 ? response.merkle_proof.index : 0;
  const signed = verifyEd25519(pubkeyHex, sigPayload(response, blockIndex, raw), response.signature);
  return { pass: signed, integrity: true, signed };
}

async function httpJSON(url: string, opts: { method?: string; token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "User-Agent": "obsideo-mcp-verify/1" };
  if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, json, text };
}

export interface VerifyProviderResult {
  provider_id: string;
  address: string;
  pass: boolean;
  signed: boolean;
  ms?: number;
  error?: string;
  older_node?: boolean;
  /** the provider answered a challenge but failed integrity/signature — a real alarm */
  failed_proof?: boolean;
}

export interface VerifyResult {
  bucket: string;
  key: string;
  root: string;
  strong: boolean; // true = verified against YOUR bytes; false = against the coordinator's root
  holders: number;
  proved: number;
  signed: number;
  mismatch: boolean; // a provider returned wrong bytes / bad signature — a real alarm
  results: VerifyProviderResult[];
}

/**
 * Verify an object by challenging its providers directly. `localPath` (your own
 * copy of the stored bytes) enables strong mode — proof that they hold YOUR
 * bytes; without it, verification falls back to the coordinator's recorded root
 * (still checks provider agreement + signatures, just not against your file).
 */
export async function verifyObject(key: string, localPath?: string): Promise<VerifyResult> {
  const cfg = loadConfig();
  if (!cfg.api_key || !cfg.bucket) {
    throw new Error(
      "Client-side verification needs an account with a coordinator API key. Provision one " +
        "(the first put auto-creates a trial), or upgrade this MCP install if the account " +
        "predates verification support (re-run signup to refresh credentials)."
    );
  }
  const bucket = cfg.bucket;
  const kitURL = `${COORDINATOR}/v1/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}/verification-kit`;
  const kit = await httpJSON(kitURL, { token: cfg.api_key });
  if (kit.status !== 200) {
    throw new Error(`verification-kit failed: HTTP ${kit.status} ${kit.text.slice(0, 200)}`);
  }
  const holders: any[] = kit.json.holders || [];

  let commitment: Commitment;
  let strong = false;
  if (localPath) {
    const data = readFileSync(localPath);
    commitment = commit(data);
    strong = true;
    if (commitment.root !== kit.json.merkle_root) {
      throw new Error(
        `MISMATCH: the root computed from ${localPath} does not match the coordinator's root ` +
          `(yours ${commitment.root.slice(0, 16)}…, coordinator ${String(kit.json.merkle_root).slice(0, 16)}…). ` +
          "Either this is not the same file, or the commitment was changed. Stop and investigate."
      );
    }
  } else {
    commitment = {
      root: kit.json.merkle_root,
      chunkHashes: null,
      chunkCount: Math.max(1, Math.ceil((kit.json.size_bytes || 1) / CHUNK_SIZE)),
    };
  }

  const results: VerifyProviderResult[] = [];
  for (const h of holders) {
    const pubkey = h.signing_public_key || null;
    if (!h.challenge_token) {
      results.push({ provider_id: h.provider_id, address: h.address, pass: false, signed: false, error: h.note || "no challenge token" });
      continue;
    }
    const idx = commitment.chunkCount > 1 ? randomInt(commitment.chunkCount) : 0;
    const challenge = {
      version: 2,
      challenge_id: "mcp-" + randomBytes(8).toString("hex"),
      merkle_root: commitment.root,
      chunk_index: idx,
      nonce: randomBytes(16).toString("hex"),
      expires_at: Math.floor(Date.now() / 1000) + 120,
      proof_version: 2,
    };
    const t0 = Date.now();
    let r;
    try {
      r = await httpJSON(h.address.replace(/\/$/, "") + "/client-challenge", {
        method: "POST", token: h.challenge_token, body: challenge,
      });
    } catch (e) {
      results.push({ provider_id: h.provider_id, address: h.address, pass: false, signed: false, error: "unreachable: " + (e as Error).message });
      continue;
    }
    const ms = Date.now() - t0;
    if (r.status === 404) {
      // Older provider node without the client-challenge endpoint. NOT a
      // durability failure — it still serves the coordinator's proof cycle.
      results.push({ provider_id: h.provider_id, address: h.address, pass: false, signed: false, ms, older_node: true, error: "older node: no client-challenge endpoint" });
      continue;
    }
    if (r.status !== 200) {
      results.push({ provider_id: h.provider_id, address: h.address, pass: false, signed: false, ms, error: `HTTP ${r.status}` + (r.status === 429 ? " (rate limited: 30/min per object)" : "") });
      continue;
    }
    const v = verifyResponse(challenge, r.json, commitment, pubkey);
    results.push({
      provider_id: h.provider_id, address: h.address,
      pass: v.pass, signed: v.signed, ms,
      failed_proof: !v.pass,
      error: v.pass ? undefined : "answered but failed integrity/signature check",
    });
  }

  // A real alarm = a provider that answered a challenge but failed the proof.
  // Older nodes, rate-limits, and unreachable providers are not alarms.
  const mismatch = results.some((r) => r.failed_proof);
  return {
    bucket, key, root: commitment.root, strong,
    holders: holders.length,
    proved: results.filter((r) => r.pass).length,
    signed: results.filter((r) => r.signed).length,
    mismatch,
    results,
  };
}
