// Live e2e for 0.6.0: the path a Hermes user follows.
//   fresh home -> put (auto-trial) -> plan -> upgrade -> portal -> usage
//   -> signup_start (claim) -> [code from inbox] -> signup_verify -> usage
//
// Run: node scripts/e2e-billing.mjs [claim-email] [code]
//   no args           : billing tools + claim start only (code lands in the inbox)
//   email             : claim start with that email, then stop
//   email code        : claim verify with a code you already received (reuses
//                       OBSIDEO_E2E_HOME from the earlier run)
//
// Against a dark shim (billing.enabled=false) the billing tools must answer
// with the honest "not enabled yet" line, never an exception. Against an
// enabled shim `upgrade` must return a checkout.stripe.com URL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , claimEmail, code] = process.argv;
const home = process.env.OBSIDEO_E2E_HOME ?? mkdtempSync(join(tmpdir(), "obsideo-mcp-billing-"));
console.log("home:", home, process.env.OBSIDEO_E2E_HOME ? "(reused)" : "(fresh, no config)");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home, OBSIDEO_SOURCE: process.env.OBSIDEO_SOURCE ?? "verify" },
});
const client = new Client({ name: "e2e-billing", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
for (const t of ["plan", "upgrade", "portal", "signup_start", "signup_verify", "put", "usage"]) {
  if (!tools.includes(t)) throw new Error(`${t} tool not registered`);
}

async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ==\n${t.slice(0, 700)}`);
  return { text: t, isError: !!r.isError };
}
const cfg = () => JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
const fail = (m) => { throw new Error(m); };

if (claimEmail && code) {
  // ---- second half: finish the claim with the emailed code ----
  const before = cfg();
  if (!before.trial) fail("home is not a trial account; nothing to claim");
  const v = await call("signup_verify", { email: claimEmail, code });
  if (v.isError) fail("claim verify errored: " + v.text);
  if (!/Claimed/.test(v.text)) fail("expected a Claimed message");
  const after = cfg();
  if (after.trial !== false) fail("trial flag not cleared");
  if (after.account_id !== before.account_id) fail("account id changed on claim");
  if (after.access_key !== before.access_key || after.account_token !== before.account_token)
    fail("credentials changed on claim (must be unchanged)");
  if (after.pending_signup_mode) fail("pending_signup_mode not cleared");
  const u = await call("usage");
  if (!/of 12(\.0)? GB/.test(u.text)) fail("usage does not show the 12 GB tier: " + u.text);
  const g = await call("get", { key: "mcp-billing-e2e/hello.txt" });
  if (!/billing e2e/.test(g.text)) fail("data written before the claim is not readable after it");
  console.log("\nCLAIM PASS: same account, same creds, 12 GB, data intact.");
  await client.close();
  process.exit(0);
}

// ---- first half: trial -> billing tools -> claim start ----
// 1. Billing tools before any account exist must say so, not crash.
if (!process.env.OBSIDEO_E2E_HOME) {
  const p0 = await call("plan");
  if (!p0.isError || !/No Obsideo account/.test(p0.text)) fail("plan without an account should explain itself");
}

// 2. First put auto-provisions a trial (0.6.0 wording: "claim it with an email").
const stamp = `mcp billing e2e ${new Date().toISOString()}`;
const p = await call("put", { key: "mcp-billing-e2e/hello.txt", content: stamp });
if (p.isError) fail("first put errored: " + p.text);
if (!process.env.OBSIDEO_E2E_HOME && !/claim it with an email/.test(p.text)) fail("trial note should point at claim");
if (!cfg().trial) fail("trial creds not saved");

// 3. plan / upgrade / portal on a trial account.
const pl = await call("plan");
if (pl.isError) fail("plan errored: " + pl.text);
const enabled = !/not enabled/.test(pl.text);
if (!/no-email trial/.test(pl.text)) fail("plan should mention the trial + claim path");

const up = await call("upgrade", { blocks: 1 });
if (up.isError) fail("upgrade errored: " + up.text);
if (enabled) {
  if (!/https:\/\/checkout\.stripe\.com\//.test(up.text)) fail("expected a checkout.stripe.com URL: " + up.text);
  if (!/Nothing has been charged/.test(up.text)) fail("upgrade must say nothing was charged");
  const up2 = await call("upgrade", { blocks: 2 });
  if (!/https:\/\/checkout\.stripe\.com\//.test(up2.text) || !/400\.0 GB/.test(up2.text)) fail("2-block checkout text: " + up2.text);
} else {
  if (!/not switched on/.test(up.text)) fail("dark shim: upgrade should say billing is not on: " + up.text);
}

const po = await call("portal");
if (po.isError) fail("portal errored: " + po.text);
if (enabled) {
  if (!/No paid plan/.test(po.text)) fail("portal on a free account should say there is no plan: " + po.text);
} else if (!/not switched on/.test(po.text)) fail("dark shim: portal should say billing is not on");

const u = await call("usage");
if (u.isError) fail("usage errored: " + u.text);
if (!/Plan:|Card billing/.test(u.text)) fail("usage should carry the billing line");

// 4. Bad-input guard.
const bad = await call("upgrade", { blocks: 0 });
if (!bad.isError) fail("blocks=0 must be rejected");

console.log(`\nBILLING PASS (shim billing ${enabled ? "ENABLED" : "dark"}).`);

// 5. Claim start (needs a real inbox; the code arrives there).
if (claimEmail) {
  const s = await call("signup_start", { email: claimEmail });
  if (s.isError) fail("claim start errored: " + s.text);
  if (!/CLAIMS the current trial/.test(s.text)) fail("signup_start on a trial should take the claim path");
  if (cfg().pending_signup_mode !== "claim") fail("pending_signup_mode not recorded");
  console.log(`\nCLAIM STARTED. Finish with:\n  OBSIDEO_E2E_HOME="${home}" node scripts/e2e-billing.mjs ${claimEmail} <code>`);
}
await client.close();
