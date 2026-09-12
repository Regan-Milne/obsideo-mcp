// End-to-end against the PUBLISHED npm package in a fresh home, the way a
// stranger's client would run it: cold npx -> trial (via first put) -> get ->
// ls -> verify -> usage -> plan -> upgrade (link only) -> signup_start (claim).
// Run: node scripts/e2e-published.mjs [version] [claim-email]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [, , version = "latest", claimEmail] = process.argv;
const home = mkdtempSync(join(tmpdir(), "obsideo-pub-"));
console.log(`home ${home}  package obsideo-mcp@${version}`);
const t = new StdioClientTransport({ command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["-y", `obsideo-mcp@${version}`], env: { ...process.env, OBSIDEO_MCP_HOME: home } });
const c = new Client({ name: "e2e-published", version: "0" }); await c.connect(t);
const sv = c.getServerVersion(); console.log("server", sv?.name, sv?.version);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
async function call(n, a = {}) { const t0 = Date.now(); const r = await c.callTool({ name: n, arguments: a });
  const txt = r.content?.[0]?.text ?? ""; console.log(`\n== ${n}${r.isError ? " (ERROR)" : ""} (${((Date.now()-t0)/1000).toFixed(1)}s)\n${txt.slice(0, 420)}`); return { txt, err: !!r.isError }; }
const stamp = `published e2e ${version} ${new Date().toISOString()}`;
const p = await call("put", { key: "e2e/proof.txt", content: stamp }); if (p.err) fail(p.txt);
if (!/trial was created/.test(p.txt)) fail("first put should auto-create a trial");
const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")); console.log("account", cfg.account_id);
const g = await call("get", { key: "e2e/proof.txt" }); if (g.txt !== stamp) fail("roundtrip mismatch");
const l = await call("ls", {}); if (!l.txt.includes("e2e/proof.txt")) fail("ls missing key");
const v = await call("verify", { key: "e2e/proof.txt" }); if (v.err || !/of \d+ providers proved possession/.test(v.txt)) fail("verify: " + v.txt);
const m = v.txt.match(/(\d+) of (\d+) providers proved/); if (m && m[1] !== m[2]) console.log("(note: not all providers proved)");
const u = await call("usage"); if (u.err) fail(u.txt);
const pl = await call("plan"); if (pl.err) fail(pl.txt);
const up = await call("upgrade", { blocks: 1 }); if (up.err || !/checkout\.stripe\.com/.test(up.txt)) fail("upgrade: " + up.txt);
const tr = await call("trial", {}); if (!tr.err || !/already configured/.test(tr.txt)) fail("trial must refuse when an account exists");
if (claimEmail) { const s = await call("signup_start", { email: claimEmail }); if (s.err || !/CLAIMS the current trial/.test(s.txt)) fail("claim start: " + s.txt);
  console.log(`\nclaim started; finish with signup_verify on home ${home}`); }
await c.close(); console.log(`\nPUBLISHED E2E PASS (${sv?.version}); account ${cfg.account_id} is internal, exclude.`);
