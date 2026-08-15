// Live e2e for encrypt-by-default + the `verify` tool: fresh home (no config)
// -> put auto-creates a trial -> objects are encrypted client-side -> verify
// proves possession against production, client-side.
// Run: node scripts/e2e-verify.mjs
//
// One trial account is provisioned per run. Note the agent name it prints and
// exclude/purge it before reading conversion numbers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-verify-"));
const transport = new StdioClientTransport({
  command: process.execPath, args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home },
});
const client = new Client({ name: "e2e-verify", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
if (!tools.includes("verify")) throw new Error("verify tool not registered");

async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ==\n${t}`);
  return { text: t, isError: !!r.isError };
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

// A file big enough to be interesting but single-chunk; keep our own copy so we
// can prove the plaintext path still supports local-file strong mode.
const local = join(home, "payload.bin");
const payload = Buffer.from(("obsideo verify e2e " + new Date().toISOString() + " ").repeat(60));
writeFileSync(local, payload);

// 1. put with no config -> auto-provisions a trial, and ENCRYPTS BY DEFAULT.
const p = await call("put", { key: "verify-e2e/data.bin", local_path: local });
assert(!p.isError, "put failed: " + p.text);
assert(/encrypted client-side/.test(p.text), "put should encrypt by default; said: " + p.text);
assert(!/PLAINTEXT/.test(p.text), "default put must not store plaintext");

const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
assert(cfg.api_key?.startsWith("obs_"), "api_key not saved to config: " + cfg.api_key);
assert(!!cfg.encryption_key, "encryption key was not generated on the default put");
assert(existsSync(join(home, "roots.json")), "roots.json commitment record was not written");
const roots = JSON.parse(readFileSync(join(home, "roots.json"), "utf8"));
const rec = roots[`${cfg.bucket}/verify-e2e/data.bin`];
assert(rec?.encrypted === true, "commitment record should be marked encrypted");
assert(rec.bytes > payload.length, "stored size should exceed plaintext (envelope + tag)");
console.log("\nsaved api_key prefix:", cfg.api_key.slice(0, 12), "agent:", cfg.agent_name);

// 2. a plaintext object, explicitly opted out, for the local-file proof path.
const pp = await call("put", { key: "verify-e2e/plain.bin", local_path: local, encrypt: false });
assert(!pp.isError, "plaintext put failed: " + pp.text);
assert(/PLAINTEXT/.test(pp.text), "encrypt=false should say so plainly; said: " + pp.text);

// Give replicas a moment to land + get challenge-ready.
await new Promise((r) => setTimeout(r, 20000));

// 3. get round-trips the encrypted object back to the original bytes.
const out = join(home, "roundtrip.bin");
const g = await call("get", { key: "verify-e2e/data.bin", local_path: out });
assert(!g.isError, "get failed: " + g.text);
assert(/decrypted/.test(g.text), "get should report decryption");
assert(readFileSync(out).equals(payload), "round-tripped bytes differ from the original");

// 4. verify the ENCRYPTED object with no local_path: strong via the recorded
//    commitment. This is the case that plain ciphertext-vs-plaintext hashing
//    could not serve, and the reason the commitment record exists.
const v = await call("verify", { key: "verify-e2e/data.bin" });
assert(!v.isError, "verify errored: " + v.text);
assert(!/ALARM|failed the proof/.test(v.text), "unexpected integrity alarm on a good object");
const m = v.text.match(/^(\d+) of (\d+) providers proved/);
assert(m && Number(m[1]) >= 1, "expected >=1 provider to prove possession, got: " + (m ? m[0] : "none"));
assert(/when it uploaded the object/.test(v.text), "expected recorded-commitment strong mode");
assert(/stored encrypted/.test(v.text), "expected the encrypted-object explanation");

// 5. the same object with local_path pointing at the PLAINTEXT must not raise a
//    false MISMATCH alarm — it must fall back to the recorded commitment.
const ve = await call("verify", { key: "verify-e2e/data.bin", local_path: local });
assert(!ve.isError, "verify with plaintext local_path must not error: " + ve.text);
assert(/when it uploaded the object/.test(ve.text), "expected recorded-commitment fallback");

// 6. the plaintext object still verifies against the local file directly.
const vp = await call("verify", { key: "verify-e2e/plain.bin", local_path: local });
assert(!vp.isError, "plaintext verify errored: " + vp.text);
assert(/YOUR local copy/.test(vp.text), "expected local-file strong mode for the plaintext object");

await call("rm", { key: "verify-e2e/data.bin" });
await call("rm", { key: "verify-e2e/plain.bin" });

console.log("\nVERIFY E2E PASS — agent", cfg.agent_name, "account", cfg.account_id);
await client.close();
