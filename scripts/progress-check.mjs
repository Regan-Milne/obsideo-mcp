// Fresh home: first put must (a) create the account with an encryption key already present,
// (b) emit progress notifications, (c) succeed. Then backup_keys, verify (bare key), usage.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "obsideo-prog-"));
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, OBSIDEO_MCP_HOME: home } });
const c = new Client({ name: "progress-check", version: "0" }); await c.connect(t);
const seen = [];
c.setNotificationHandler(ProgressNotificationSchema, (n) => { seen.push(n.params.message ?? ""); });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const call = (name, args = {}, progress = false) => c.callTool({ name, arguments: args }, undefined, progress ? { onprogress: (p) => seen.push("[cb] " + (p.message ?? "")) } : undefined);
console.log("tools:", (await c.listTools()).tools.length);
const t0 = Date.now();
const p = await call("put", { key: "e2e/proof.txt", content: "progress e2e " + new Date().toISOString() }, true);
console.log(`put ${p.isError ? "ERROR" : "ok"} in ${((Date.now()-t0)/1000).toFixed(1)}s`); if (p.isError) fail(p.content[0].text);
console.log("progress lines:", seen.length); seen.slice(0, 12).forEach((m) => console.log("  ", m.slice(0, 110)));
if (seen.length === 0) fail("no progress notifications received");
const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
if (!cfg.encryption_key) fail("encryption key not created with the account"); console.log("account", cfg.account_id, "key present:", !!cfg.encryption_key);
const b = await call("backup_keys", { destination: join(home, "keys-backup.tar.gz") }); console.log("backup_keys:", b.content[0].text.slice(0, 140)); if (b.isError || !existsSync(join(home, "keys-backup.tar.gz"))) fail("backup missing");
const v = await call("verify", { key: "e2e/proof.txt" }); const line = v.content[0].text.split("\n")[0]; console.log("verify:", line); if (/mlvault\//.test(line)) fail("bucket prefix still shown");
const u = await call("usage"); console.log("usage:", u.content[0].text.split("\n")[0]);
const tr = await call("trial", {}); if (!tr.isError) fail("trial must refuse");
await c.close(); console.log(`\nPROGRESS/0.6.4 PASS; account ${cfg.account_id} is internal, exclude.`);
