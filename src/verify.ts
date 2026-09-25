/**
 * Client-side proof of retrievability.
 *
 * Challenges every provider holding an object directly and compares each
 * answer on this machine against a merkle root: one computed from a local file,
 * one this client recorded at upload time, or, failing both, the coordinator's.
 * The coordinator chooses which providers to ask, where to reach them, and the
 * public keys their signatures are checked against. trustNote() below states
 * which of those a given result relied on.
 */

import { createHash, createPublicKey, verify as edVerify, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { expandPath, loadConfig, lookupRoot } from "./config.js";

const CHUNK_SIZE = 1048576;
const SIG_DOMAIN = "obsideo-proof-response-v1";
const COORDINATOR = process.env.OBSIDEO_COORDINATOR_URL ?? "https://coordinator.obsideo.io";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sha3_512 = (b: Buffer) => createHash("sha3-512").update(b).digest();

function chunkHash(index: number, bytes: Buffer): Buffer {
  return sha256(Buffer.from(String(index) + bytes.toString("hex"), "ascii"));
}

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

/** Commitment recorded at upload time (see config.recordRoot). */
export function commitRoot(data: Buffer): string {
  return commit(data).root;
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

/** Validate one provider response against the challenge and the commitment. */
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

/** The coordinator advertises a root we did not commit to. Overwrite is the
 *  common cause; a changed commitment is the alarming one. Say both. */
function rootDrift(key: string, ours: string, theirs: string): string {
  return (
    `MISMATCH: the coordinator is advertising a different root than the one this machine ` +
    `committed when it uploaded ${key} (ours ${ours.slice(0, 16)}…, coordinator ` +
    `${theirs.slice(0, 16)}…). Most likely the object was overwritten since; the other ` +
    "possibility is that the commitment was changed. Stop and investigate."
  );
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

/** Where the root we verified against came from. Only "coordinator" is weak. */
export type RootSource = "local-file" | "recorded" | "coordinator";

export interface VerifyResult {
  bucket: string;
  key: string;
  root: string;
  strong: boolean; // true = verified against YOUR bytes; false = against the coordinator's root
  rootSource: RootSource;
  /** set when the local file is the plaintext of an object stored encrypted */
  encryptedObject?: boolean;
  holders: number;
  proved: number;
  signed: number;
  mismatch: boolean; // a provider returned wrong bytes / bad signature — a real alarm
  results: VerifyProviderResult[];
}

/**
 * The closing line of a verify result: what the verdict actually rested on.
 *
 * This used to read "trusted nothing the coordinator asserted" on every result,
 * including when the root itself came from the coordinator and when no provider
 * answered at all.
 *
 * Three separate facts, each stated only when it is true of this result:
 *
 *   what the answers were compared against  (rootSource, encryptedObject)
 *   whether the answers were signed          (signed vs proved)
 *   what the coordinator still chose          (always: providers, addresses, keys)
 *
 * The comparison itself runs on this machine. But the chunks, merkle paths,
 * holder addresses and challenge tokens all arrive from servers the coordinator
 * named, and an unsigned pass happens whenever the coordinator's listing has no
 * public key for a provider. So no sentence here claims more than that.
 *
 * Nothing affirmative is said unless at least one provider passed: a result with
 * only failed proofs already carries an integrity alarm, and must never be
 * followed by a sentence that reads as success. 0.7.4 got that case wrong.
 * Found during an outside agent review, 2026-09-22 and 2026-09-24.
 */
export function trustNote(
  r: Pick<VerifyResult, "rootSource" | "encryptedObject" | "proved" | "signed">
): string {
  if (r.proved <= 0) return "";

  const parts: string[] = [];

  if (r.rootSource === "local-file") {
    parts.push(
      "The comparison ran on this machine, against a root computed just now from the file you " +
        "passed as local_path, so it does not depend on the coordinator's word about what was stored."
    );
  } else if (r.rootSource === "recorded") {
    parts.push(
      "The comparison ran on this machine, against the root this machine recorded when it uploaded " +
        "the object" +
        (r.encryptedObject ? " (the root of the encrypted bytes, since the object is stored encrypted)" : "") +
        ", so it does not depend on the coordinator's word about what was stored."
    );
  } else {
    parts.push(
      "The comparison ran on this machine, but against the coordinator's record of what was stored, " +
        "not a root from your bytes. It shows the providers hold what the coordinator says was stored, " +
        "not that it matches your copy. Pass local_path for that."
    );
  }

  const unsigned = r.proved - r.signed;
  if (unsigned <= 0) {
    parts.push(
      "Every passing answer was signed, and each signature was checked against that provider's " +
        "public key as listed by the coordinator, so which provider answered relies on that listing."
    );
  } else if (r.signed === 0) {
    parts.push(
      "None of the passing answers were signed, because the coordinator's listing had no public key " +
        "for those providers, so this does not show which provider answered."
    );
  } else {
    parts.push(
      `${r.signed} of ${r.proved} passing answers were signed and checked against the provider's ` +
        "public key as listed by the coordinator. The rest were unsigned, because the listing had no " +
        "public key for those providers, so for them this does not show which provider answered."
    );
  }

  parts.push("The coordinator also chose which providers to ask and where to reach them.");
  return parts.join(" ");
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

  // Our own commitment, written at upload time. Load it first: for an object
  // stored encrypted it is the ONLY way to prove "they hold my bytes", because
  // ciphertext cannot be reproduced from the plaintext (fresh IV per put).
  const recorded = lookupRoot(bucket, key);
  const coordRoot = String(kit.json.merkle_root ?? "");
  const recordedUsable = !!recorded && recorded.root === coordRoot;

  const weakCommitment = (): Commitment => ({
    root: coordRoot,
    chunkHashes: null,
    chunkCount: Math.max(1, Math.ceil((kit.json.size_bytes || 1) / CHUNK_SIZE)),
  });

  let commitment: Commitment;
  let strong = false;
  let rootSource: RootSource = "coordinator";
  let encryptedObject = false;

  if (localPath) {
    const data = readFileSync(expandPath(localPath));
    const local = commit(data);
    if (local.root === coordRoot) {
      // The file on disk IS the stored object. Strongest case: full chunk
      // hashes, so every challenged chunk is checked against the user's bytes.
      commitment = local;
      strong = true;
      rootSource = "local-file";
    } else if (recordedUsable && recorded!.encrypted) {
      // Expected: the object was encrypted before upload, so the stored bytes
      // are ciphertext and will never match the plaintext file. Not an alarm.
      commitment = weakCommitment();
      commitment.root = recorded!.root;
      strong = true;
      rootSource = "recorded";
      encryptedObject = true;
      commitment.chunkCount = Math.max(1, Math.ceil(recorded!.bytes / CHUNK_SIZE));
    } else if (recorded && recorded.root !== coordRoot) {
      throw new Error(rootDrift(key, recorded.root, coordRoot));
    } else {
      throw new Error(
        `MISMATCH: the root computed from ${localPath} does not match the coordinator's root ` +
          `(yours ${local.root.slice(0, 16)}…, coordinator ${coordRoot.slice(0, 16)}…). ` +
          "Either this is not the same file, or the commitment was changed. Stop and investigate."
      );
    }
  } else if (recordedUsable) {
    // No local file needed: we committed to these bytes ourselves at upload
    // time and the coordinator is still advertising the same root.
    commitment = weakCommitment();
    commitment.root = recorded!.root;
    commitment.chunkCount = Math.max(1, Math.ceil(recorded!.bytes / CHUNK_SIZE));
    strong = true;
    rootSource = "recorded";
    encryptedObject = recorded!.encrypted;
  } else {
    if (recorded && recorded.root !== coordRoot) {
      throw new Error(rootDrift(key, recorded.root, coordRoot));
    }
    commitment = weakCommitment();
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
    bucket, key, root: commitment.root, strong, rootSource,
    encryptedObject: encryptedObject || undefined,
    holders: holders.length,
    proved: results.filter((r) => r.pass).length,
    signed: results.filter((r) => r.signed).length,
    mismatch,
    results,
  };
}
