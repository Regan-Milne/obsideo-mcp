// Live e2e for the `verify` tool: fresh home (no config) -> put auto-creates a
// trial -> verify proves possession client-side against production.
// Run: node scripts/e2e-verify.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-verify-"));
const transport = new StdioClientTransport({
  command: process.execPath, args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home },
});
const client = new Client({ name: "e2e-verify", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
if (!tools.includes("verify")) throw new Error("verify tool not registered");

async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ==\n${t}`);
  return { text: t, isError: !!r.isError };
}

// A file big enough to be interesting but single-chunk; keep our own copy for strong mode.
const local = join(home, "payload.bin");
writeFileSync(local, Buffer.from(("obsideo verify e2e " + new Date().toISOString() + " ").repeat(60)));

// 1. put with no config -> auto-provisions a trial (now carrying the api_key)
const p = await call("put", { key: "verify-e2e/data.bin", local_path: local });
if (p.isError) throw new Error("put failed: " + p.text);
const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
if (!cfg.api_key || !cfg.api_key.startsWith("obs_")) throw new Error("api_key not saved to config: " + JSON.stringify(cfg.api_key));
console.log("\nsaved api_key prefix:", cfg.api_key.slice(0, 12), "agent:", cfg.agent_name);

// Give replicas a moment to land + get challenge-ready.
await new Promise((r) => setTimeout(r, 20000));

// 2. verify STRONG (against our local copy)
const v = await call("verify", { key: "verify-e2e/data.bin", local_path: local });
if (v.isError) throw new Error("verify errored: " + v.text);
if (!/proved possession/.test(v.text)) throw new Error("no possession result");
if (/ALARM|failed the proof/.test(v.text)) throw new Error("unexpected integrity alarm on a good object");
const m = v.text.match(/^(\d+) of (\d+) providers proved/);
if (!m || Number(m[1]) < 1) throw new Error("expected >=1 provider to prove possession, got: " + (m ? m[0] : "none"));
if (!/YOUR local copy/.test(v.text)) throw new Error("expected strong-mode confirmation");

// 3. verify WEAK (no local copy) still works
const vw = await call("verify", { key: "verify-e2e/data.bin" });
if (vw.isError) throw new Error("weak verify errored");
if (!/coordinator's recorded root/.test(vw.text)) throw new Error("expected weak-mode note");

// cleanup object (leave account for coordinator-side confirmation)
await call("rm", { key: "verify-e2e/data.bin" });

console.log("\nVERIFY E2E PASS — agent", cfg.agent_name, "account", cfg.account_id);
await client.close();
