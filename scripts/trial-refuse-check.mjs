import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, OBSIDEO_MCP_HOME: 'C:\Users\USER\AppData\Local\Temp\obsideo-mcp-billing-EkbJRc' } });
const c = new Client({ name: "refuse", version: "0" }); await c.connect(t);
const r = await c.callTool({ name: "trial", arguments: { source: "test" } });
console.log(r.isError ? "REFUSED OK: " : "NOT REFUSED: ", r.content[0].text.slice(0, 200)); await c.close();
