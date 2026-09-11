// Ask the configured account for a real checkout link (charges nothing). Run with OBSIDEO_MCP_HOME set.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env } });
const c = new Client({ name: "checkout-link", version: "0" }); await c.connect(t);
for (const [n, a] of [["plan", {}], ["upgrade", { blocks: 1 }]]) {
  const r = await c.callTool({ name: n, arguments: a }); console.log(`\n== ${n}${r.isError ? " (ERROR)" : ""} ==\n${r.content[0].text}`);
}
await c.close();
