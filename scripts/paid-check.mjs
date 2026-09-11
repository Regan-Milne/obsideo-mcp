// Paid-account branch against the mock shim (MOCK_PAID=1): 409 subscription_exists,
// pending offer shown as NOT applied, portal link. Run: see mock-shim.mjs header.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const home = process.env.OBSIDEO_E2E_HOME; if (!home) throw new Error("set OBSIDEO_E2E_HOME");
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home, OBSIDEO_SIGNUP_URL: process.env.OBSIDEO_SIGNUP_URL } });
const c = new Client({ name: "paid-check", version: "0" }); await c.connect(transport);
const out = {};
for (const [n, a] of [["plan", {}], ["upgrade", { blocks: 1 }], ["portal", {}], ["usage", {}]]) {
  const r = await c.callTool({ name: n, arguments: a }); out[n] = r.content[0].text;
  console.log(`\n== ${n}${r.isError ? " (ERROR)" : ""} ==\n${out[n]}`);
}
await c.close();
const fail = (m) => { throw new Error(m); };
if (!/Plan: 2 x 200 GB = 400\.0 GB for \$10\.00\/month \(status active\)/.test(out.plan)) fail("plan line");
if (!/Offer waiting \(not applied\): 3 x 200 GB = 600 GB for \$15\.00\/month/.test(out.plan)) fail("offer line");
if (!/agree_url|stepup\/tok_mock/.test(out.plan)) fail("agree url missing");
if (!/already has a paid plan; this tool never changes an existing plan's size/.test(out.upgrade)) fail("409 branch");
if (/checkout\.stripe\.com/.test(out.upgrade)) fail("paid account must not get a checkout link");
if (!/billing\.stripe\.com/.test(out.portal)) fail("portal url");
if (!/Plan: 2 x 200 GB/.test(out.usage)) fail("usage plan line");
console.log("\nPAID-BRANCH PASS");
