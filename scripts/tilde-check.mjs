// put with a "~/" local_path must expand to the home dir (the first Hermes run died on this).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const home = process.env.OBSIDEO_E2E_HOME; if (!home) throw new Error("set OBSIDEO_E2E_HOME");
mkdirSync(join(homedir(), ".obsideo-tilde-check"), { recursive: true });
writeFileSync(join(homedir(), ".obsideo-tilde-check", "hello.txt"), "tilde check " + new Date().toISOString());
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...process.env, OBSIDEO_MCP_HOME: home } });
const c = new Client({ name: "tilde-check", version: "0" }); await c.connect(t);
const r = await c.callTool({ name: "put", arguments: { key: "tilde-check/hello.txt", local_path: "~/.obsideo-tilde-check/hello.txt" } });
console.log(r.isError ? "ERROR " : "OK ", r.content[0].text.slice(0, 160));
const g = await c.callTool({ name: "get", arguments: { key: "tilde-check/hello.txt", local_path: "~/.obsideo-tilde-check/back.txt" } });
console.log(g.isError ? "ERROR " : "OK ", g.content[0].text.slice(0, 160));
await c.close(); if (r.isError || g.isError) process.exit(1);
