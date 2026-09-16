// Acceptance run for the Hermes catalog entry: runs the EXACT transport
// command from catalog/hermes/manifest.yaml in a fresh home, the way
// `hermes mcp install obsideo` would, and walks the third-party evaluation
// sequence (2026-09-12): cold npx -> auto-trial via first put -> ls -> verify
// -> get + SHA-256 match -> backup_keys -> usage -> signup_start (claim).
// Phase 2 finishes the claim with the emailed code and re-checks put/verify/usage.
//   node scripts/e2e-catalog.mjs phase1 <claim-email>
//   node scripts/e2e-catalog.mjs phase2 <home> <6-digit-code>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [, , phase, a1, a2] = process.argv;
const manifest = readFileSync(new URL("../catalog/hermes/manifest.yaml", import.meta.url), "utf8");
const cmd = /command:\s*(\S+)/.exec(manifest)[1];
const args = [...manifest.matchAll(/^\s+-\s+"([^"]+)"\s*$/gm)].map(m => m[1]).filter(x => x === "-y" || x.startsWith("obsideo-mcp@"));
const defaults = [...manifest.matchAll(/default_enabled:\n((?:\s+-\s+\w+\n)+)/g)].flatMap(m => [...m[1].matchAll(/-\s+(\w+)/g)].map(x => x[1]));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const home = phase === "phase1" ? mkdtempSync(join(tmpdir(), "obsideo-catalog-")) : a1;
console.log(`manifest command: ${cmd} ${args.join(" ")}\nhome ${home}`);
const t = new StdioClientTransport({ command: process.platform === "win32" ? cmd + ".cmd" : cmd, args, cwd: home,
  env: { ...process.env, OBSIDEO_MCP_HOME: home, OBSIDEO_SOURCE: "verify" } });
const c = new Client({ name: "hermes-catalog-acceptance", version: "0" }); await c.connect(t);
const sv = c.getServerVersion(); console.log("server", sv?.name, sv?.version);
async function call(n, x = {}) { const t0 = Date.now(); const r = await c.callTool({ name: n, arguments: x });
  const txt = r.content?.[0]?.text ?? ""; console.log(`\n== ${n}${r.isError ? " (ERROR)" : ""} (${((Date.now()-t0)/1000).toFixed(1)}s)\n${txt.slice(0, 500)}`); return { txt, err: !!r.isError }; }
const sha = (s) => createHash("sha256").update(s).digest("hex");
if (phase === "phase1") {
  const tools = (await c.listTools()).tools.map(t => t.name).sort();
  console.log("\nTOOLS (" + tools.length + "):", tools.join(" "));
  const missing = defaults.filter(d => !tools.includes(d)); const extra = tools.filter(t => !defaults.includes(t));
  console.log("manifest default_enabled not on server:", missing.length ? missing.join(" ") : "none");
  console.log("server tools not in default_enabled:", extra.length ? extra.join(" ") : "none");
  const stamp = `hermes catalog acceptance ${sv?.version} ${new Date().toISOString()}`;
  const p = await call("put", { key: "hermes/proof.txt", content: stamp }); if (p.err) fail(p.txt);
  if (!/trial was created/i.test(p.txt)) fail("first put should auto-create a trial");
  const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")); console.log("account", cfg.account_id, "key present:", !!(cfg.data_key || cfg.key || cfg.aes_key || cfg.encryption_key));
  const l = await call("ls", {}); if (!l.txt.includes("hermes/proof.txt")) fail("ls missing key");
  const v = await call("verify", { key: "hermes/proof.txt" }); if (v.err || !/of \d+ providers proved possession/.test(v.txt)) fail("verify: " + v.txt);
  const m = v.txt.match(/(\d+) of (\d+) providers proved/); console.log("verify:", m?.[0]);
  const g = await call("get", { key: "hermes/proof.txt" }); if (g.txt !== stamp) fail("roundtrip mismatch");
  console.log("SHA-256 original", sha(stamp).slice(0, 16), "returned", sha(g.txt).slice(0, 16), sha(stamp) === sha(g.txt) ? "MATCH" : "MISMATCH");
  const b = await call("backup_keys", { path: join(home, "obsideo-keys-backup.tar.gz") }); if (b.err) fail("backup_keys: " + b.txt);
  console.log("backup exists:", existsSync(join(home, "obsideo-keys-backup.tar.gz")));
  const u = await call("usage"); if (u.err) fail(u.txt);
  const s = await call("signup_start", { email: a1 }); if (s.err) fail("claim start: " + s.txt);
  await c.close(); console.log(`\nPHASE 1 PASS. Finish: node scripts/e2e-catalog.mjs phase2 "${home}" <code>   (account ${cfg.account_id} is internal, exclude)`);
} else {
  const cfg0 = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
  const vr = await call("signup_verify", { email: process.env.CLAIM_EMAIL, code: a2 }); if (vr.err) fail("claim verify: " + vr.txt);
  const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")); console.log("account before/after claim:", cfg0.account_id, "->", cfg.account_id);
  const g = await call("get", { key: "hermes/proof.txt" }); if (g.err) fail("get after claim: " + g.txt);
  const stamp2 = `after claim ${new Date().toISOString()}`;
  const p = await call("put", { key: "hermes/after-claim.txt", content: stamp2 }); if (p.err) fail(p.txt);
  const v = await call("verify", { key: "hermes/after-claim.txt" }); if (v.err) fail("verify: " + v.txt);
  const u = await call("usage"); if (u.err || !/12(\.0)? ?GB/.test(u.txt)) fail("usage should show 12 GB after claim: " + u.txt);
  await c.close(); console.log("\nPHASE 2 PASS: claim kept the account, data readable, 12 GB quota.");
}
