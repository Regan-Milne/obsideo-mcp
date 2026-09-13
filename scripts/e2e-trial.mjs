// Live e2e for auto-provision-on-first-use: a fresh home with NO config,
// first `put` must silently create a trial account and store the object.
// Run: node scripts/e2e-trial.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-trial-"));
console.log("fresh home (no config):", home);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home, OBSIDEO_SOURCE: process.env.OBSIDEO_SOURCE ?? "verify" },
});
const client = new Client({ name: "e2e-trial", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
if (!tools.includes("trial")) throw new Error("trial tool not registered");

async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ==\n${t.slice(0, 500)}`);
  return { text: t, isError: !!r.isError };
}

// 1. First put with NO config -> must auto-provision a trial, then store.
const stamp = `mcp trial auto-provision e2e ${new Date().toISOString()}`;
const p = await call("put", { key: "mcp-trial-e2e/hello.txt", content: stamp });
if (p.isError) throw new Error("first put errored: " + p.text);
if (!/trial/i.test(p.text)) throw new Error("expected a trial provisioning note on first put");
if (!/agent \"/.test(p.text)) throw new Error("expected an agent name in the note");

// 2. Config now has trial creds.
const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
if (!cfg.trial || !cfg.agent_name || !cfg.access_key) throw new Error("trial creds not saved");
console.log("\nsaved agent:", cfg.agent_name, "account:", cfg.account_id);
if (!existsSync(join(home, "signing.pem"))) throw new Error("signing.pem not written");

// 3. Subsequent ops reuse the account with NO new provisioning note.
const g = await call("get", { key: "mcp-trial-e2e/hello.txt" });
if (g.text !== stamp) throw new Error("roundtrip mismatch: " + JSON.stringify(g.text));
if (/No account was configured/.test(g.text)) throw new Error("get should not re-provision");

const l = await call("ls", { prefix: "mcp-trial-e2e/" });
if (!l.text.includes("hello.txt")) throw new Error("ls missing key");

const u = await call("usage", {});
if (!/of 0.1 GB|of 0.10 GB|100/.test(u.text)) console.log("(usage quota text:", u.text, ")");

// 4. Encrypted put on the trial account.
await call("put", { key: "mcp-trial-e2e/enc.bin", content: "secret " + stamp, encrypt: true });
const ge = await call("get", { key: "mcp-trial-e2e/enc.bin" });
if (!ge.text.includes("secret ")) throw new Error("encrypted roundtrip failed");

// 5. Clean up the objects (leave the account for coordinator verification).
await call("rm", { key: "mcp-trial-e2e/hello.txt" });
await call("rm", { key: "mcp-trial-e2e/enc.bin" });

console.log("\nTRIAL E2E PASS — agent", cfg.agent_name, "account", cfg.account_id);
await client.close();
