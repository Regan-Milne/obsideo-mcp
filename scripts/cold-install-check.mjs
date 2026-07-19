// Cold-install check: spawn the PUBLISHED package via npx (fresh fetch from
// the public registry) and verify the server initializes and lists all tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-cold-"));
const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["-y", "--prefer-online", "obsideo-mcp@0.1.0"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home },
});
const client = new Client({ name: "cold-check", version: "0.0.0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools from published package:", tools.join(", "));
const expected = ["get", "ls", "put", "rm", "signup_start", "signup_verify", "usage"];
if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error("tool list mismatch");
// one real call through the published binary: labeled-error passthrough
const r = await client.callTool({ name: "signup_start", arguments: { email: "you@example.com" } });
if (!r.content[0].text.includes("placeholder_email")) throw new Error("labeled error missing");
console.log("labeled-error passthrough OK");
console.log("COLD INSTALL PASS");
await client.close();
