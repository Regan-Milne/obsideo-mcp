// Production end-to-end for the direct transport, AS US.
//
// Mints a real trial on signup.obsideo.io with User-Agent obsideo-verify/1.0
// and source=verify (both excluded by the funnel tooling), writes an isolated
// config under a temp OBSIDEO_MCP_HOME, then drives the built storage module:
// put -> get (byte-exact) -> ls -> rm, timing the first put. Prints no secrets.
//
//   npm run build && node test/e2e_prod.mjs            # direct transport
//   OBSIDEO_TRANSPORT=s3 node test/e2e_prod.mjs         # old path, for comparison
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIGNUP = process.env.OBSIDEO_SIGNUP_URL ?? "https://signup.obsideo.io";
const UA = "obsideo-verify/1.0";
const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function post(path, body) {
  const r = await fetch(SIGNUP + path, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// OBSIDEO_E2E_REUSE_HOME=<dir with mcp.json>: skip minting (the shim caps
// trials per address; our own test runs hit that cap) and drive an existing
// verify-sourced trial instead.
const reuse = process.env.OBSIDEO_E2E_REUSE_HOME;
let home;
let agentName;
if (reuse) {
  home = reuse;
  agentName = JSON.parse((await import("node:fs")).readFileSync(join(home, "mcp.json"), "utf8")).agent_name;
  console.log(`[${ms()}] reusing ${home} (agent=${agentName})`);
} else {
const start = await post("/v1/trial/start", { source: "verify" });
console.log(`[${ms()}] start ok  bits=${start.pow_bits} wait=${start.min_wait_seconds}s`);
let nonce = 0;
for (;;) {
  const d = createHash("sha256").update(`${start.pow_challenge}:${nonce}`).digest();
  if (d.readUInt32BE(0) >> (32 - start.pow_bits) === 0) break;
  nonce++;
}
const { publicKey } = generateKeyPairSync("ed25519");
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const pub = "obk_sig_" + Buffer.from(raw).toString("base64url");
await new Promise((r) => setTimeout(r, start.min_wait_seconds * 1000));
const tr = Date.now();
const red = await post("/v1/trial/redeem", {
  ticket: start.ticket, nonce: String(nonce), customer_signing_public_key: pub, source: "verify",
  transport: (process.env.OBSIDEO_TRANSPORT ?? "").toLowerCase() === "s3" ? "s3" : "direct",
});
console.log(`[${ms()}] redeem ok in ${((Date.now() - tr) / 1000).toFixed(1)}s  agent=${red.agent_name} bucket=${red.bucket} bucket_created=${red.bucket_created}`);

home = mkdtempSync(join(tmpdir(), "obsideo-mcp-e2e-"));
agentName = red.agent_name;
writeFileSync(join(home, "mcp.json"), JSON.stringify({
  email: `trial:${red.agent_name}`, account_id: red.account_id, account_token: red.account_token,
  api_key: red.api_key, endpoint: red.endpoint, region: red.region, bucket: red.bucket,
  access_key: red.access_key, secret_key: red.secret_key, trial: true, agent_name: red.agent_name,
}));
}
process.env.OBSIDEO_MCP_HOME = home;
// Declare this run as ours AT SIGNUP. Without it the account it creates is
// indistinguishable from a real first `put` and lands in the funnel as a
// customer -- which is exactly what happened on 2026-09-12.
process.env.OBSIDEO_SOURCE = process.env.OBSIDEO_SOURCE ?? "verify";

const storage = await import("../dist/storage.js");
const key = `e2e/direct-${Date.now()}.txt`;
const content = `direct transport e2e ${new Date().toISOString()}\n` + "x".repeat(4096);

const tp = Date.now();
const putMsg = await storage.put({ key, content });
console.log(`[${ms()}] put ok in ${((Date.now() - tp) / 1000).toFixed(1)}s  -> ${putMsg.split(" IMPORTANT")[0].slice(0, 140)}`);

const got = await storage.get(key);
console.log(`[${ms()}] get ok  byte-exact=${got.text === content}  encrypted=${got.encrypted}`);

const ls = await storage.ls("e2e/");
console.log(`[${ms()}] ls ok  -> ${ls.split("\n").slice(-1)[0]}`);

console.log(`[${ms()}] rm -> ${await storage.rm(key)}`);
console.log(`transport=${process.env.OBSIDEO_TRANSPORT ?? "direct (default)"}  account=trial-${agentName}  (source=verify; exclude from conversion counts)`);
