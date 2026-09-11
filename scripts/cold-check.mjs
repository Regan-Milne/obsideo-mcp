// Cold install check: what does `npx -y obsideo-mcp@latest` actually serve right now?
// Run: node scripts/cold-check.mjs   (fresh OBSIDEO_MCP_HOME; lists tools only, creates no account)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "obsideo-cold-"));
const t = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["-y", "obsideo-mcp@latest"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home },
});
const c = new Client({ name: "cold-check", version: "0" });
await c.connect(t);
const v = c.getServerVersion();
const tools = (await c.listTools()).tools.map((x) => x.name).sort();
console.log(`server ${v?.name} ${v?.version}: ${tools.length} tools: ${tools.join(", ")}`);
await c.close();
