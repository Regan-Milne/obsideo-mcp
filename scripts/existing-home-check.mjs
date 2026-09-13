// backup_keys / verify (bare key) / usage / trial-refusal against an EXISTING home
// (for when the per-address trial cap is spent). Run with OBSIDEO_MCP_HOME set.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
const home = process.env.OBSIDEO_MCP_HOME; if (!home) throw new Error("set OBSIDEO_MCP_HOME");
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env } });
const c = new Client({ name: "existing-home-check", version: "0" }); await c.connect(t);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const call = async (n, a = {}) => { const r = await c.callTool({ name: n, arguments: a }); return { txt: r.content[0].text, err: !!r.isError }; };
const dest = join(home, "keys-backup.tar.gz");
const b = await call("backup_keys", { destination: dest }); console.log("backup_keys:", b.txt.slice(0, 120)); if (b.err || !existsSync(dest)) fail("archive missing"); console.log("archive bytes:", statSync(dest).size);
const d = await call("backup_keys", { destination: join(home, "keys-copy") }); console.log("backup_keys dir:", d.txt.slice(0, 80)); if (d.err || !existsSync(join(home, "keys-copy", "mcp.json"))) fail("dir copy missing");
const p = await call("put", { key: "e2e/again.txt", content: "existing-home " + Date.now() }); if (p.err) fail(p.txt);
const v = await call("verify", { key: "e2e/again.txt" }); const line = v.txt.split("\n")[0]; console.log("verify:", line); if (v.err || /mlvault\//.test(line)) fail("verify prefix/err");
const u = await call("usage"); console.log("usage:", u.txt.split("\n")[0]); if (u.err) fail(u.txt);
const tr = await call("trial", {}); if (!tr.err || !/already configured/.test(tr.txt)) fail("trial must refuse");
await c.close(); console.log("\nEXISTING-HOME PASS");
