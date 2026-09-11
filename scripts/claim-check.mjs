// Claim wiring against the mock shim, on a COPY of a trial home so the real
// trial account's local state is untouched. Proves: signup_start takes the
// claim path + records the mode; email_in_use is explained with the
// abandon_trial way out; wrong code passes the labeled error through; the
// right code clears trial, keeps account id + every credential, drops the mode.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const src = process.env.OBSIDEO_E2E_HOME; if (!src) throw new Error("set OBSIDEO_E2E_HOME (a trial home)");
const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-claim-")); cpSync(src, home, { recursive: true });
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home, OBSIDEO_SIGNUP_URL: process.env.OBSIDEO_SIGNUP_URL } });
const c = new Client({ name: "claim-check", version: "0" }); await c.connect(transport);
const cfg = () => JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
const call = async (n, a) => { const r = await c.callTool({ name: n, arguments: a }); const t = r.content[0].text;
  console.log(`\n== ${n}${r.isError ? " (ERROR)" : ""} ==\n${t}`); return { t, err: !!r.isError }; };
const fail = (m) => { throw new Error(m); };
const before = cfg(); if (!before.trial) fail("source home is not a trial");
const taken = await call("signup_start", { email: "taken@example.com" });
if (!taken.err || !/abandon_trial=true/.test(taken.t)) fail("email_in_use must explain abandon_trial");
const s = await call("signup_start", { email: "someone@example.org" });
if (s.err || !/CLAIMS the current trial/.test(s.t) || cfg().pending_signup_mode !== "claim") fail("claim start");
const wrong = await call("signup_verify", { email: "someone@example.org", code: "000000" });
if (!wrong.err || !/otp_error/.test(wrong.t)) fail("wrong code must pass the labeled error through");
if (cfg().trial !== true) fail("a failed verify must not touch the trial flag");
const v = await call("signup_verify", { email: "someone@example.org", code: "123456" });
if (v.err || !/^Claimed\./.test(v.t)) fail("claim verify");
const after = cfg();
if (after.trial !== false || after.email !== "someone@example.org") fail("trial flag/email not updated");
for (const k of ["account_id", "account_token", "api_key", "access_key", "secret_key", "encryption_key", "bucket", "endpoint"])
  if (after[k] !== before[k]) fail(`${k} changed on claim`);
if ("pending_signup_mode" in after || "trial_expires_at" in after) fail("pending mode / trial expiry not cleared");
await c.close();
console.log("\nCLAIM-WIRING PASS (mock shim; creds identical before/after)");
