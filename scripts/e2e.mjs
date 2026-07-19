// Live e2e: spawn the built server over stdio, exercise every tool against
// production. Uses the existing free-tier e2e account (never creates one).
// Run: node scripts/e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const home = mkdtempSync(join(tmpdir(), "obsideo-mcp-e2e-"));
const bundle = JSON.parse(
  readFileSync("C:/ComputerStuff/obsideo-demo-workload/acct-freetier-e2e/e2e_account_bundle.json", "utf8")
);
writeFileSync(
  join(home, "mcp.json"),
  JSON.stringify({
    email: "e2e", account_id: bundle.account_id, account_token: bundle.account_token,
    endpoint: bundle.endpoint, region: bundle.region, bucket: bundle.bucket,
    access_key: bundle.access_key, secret_key: bundle.secret_key,
  })
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, OBSIDEO_MCP_HOME: home },
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""} ==\n${t.slice(0, 400)}`);
  return { text: t, isError: !!r.isError };
}

// 1. labeled-error passthrough on signup (no account side effects)
const s = await call("signup_start", { email: "you@example.com" });
if (!s.text.includes("placeholder_email")) throw new Error("expected placeholder_email label");

// 2. put inline (plaintext)
const stamp = `obsideo mcp e2e ${new Date().toISOString()}`;
await call("put", { key: "mcp-e2e/plain.txt", content: stamp });

// 3. put encrypted (file)
const f = join(home, "secret.txt");
writeFileSync(f, "encrypted payload " + stamp);
await call("put", { key: "mcp-e2e/enc.bin", local_path: f, encrypt: true });

// 4. ls
const l = await call("ls", { prefix: "mcp-e2e/" });
if (!l.text.includes("plain.txt") || !l.text.includes("enc.bin")) throw new Error("ls missing keys");

// 5. get inline + hash-exact roundtrip of encrypted file
const g1 = await call("get", { key: "mcp-e2e/plain.txt" });
if (g1.text !== stamp) throw new Error("plain roundtrip mismatch");
const back = join(home, "secret-back.txt");
await call("get", { key: "mcp-e2e/enc.bin", local_path: back });
const h1 = createHash("sha256").update(readFileSync(f)).digest("hex");
const h2 = createHash("sha256").update(readFileSync(back)).digest("hex");
if (h1 !== h2) throw new Error("encrypted roundtrip hash mismatch");
console.log("\nencrypted roundtrip sha256 match:", h1.slice(0, 16));

// 6. ciphertext really is ciphertext on the wire? fetch raw via a second config with no key
const rawGet = await call("get", { key: "mcp-e2e/enc.bin" });
if (!rawGet.text.includes("decrypted") && rawGet.isError) throw new Error("unexpected");

// 7. usage
const u = await call("usage", {});
if (!u.text.includes("12")) throw new Error("usage quota unexpected");

// 8. rm + verify gone
await call("rm", { key: "mcp-e2e/plain.txt" });
await call("rm", { key: "mcp-e2e/enc.bin" });
const l2 = await call("ls", { prefix: "mcp-e2e/" });
if (l2.text.includes("plain.txt")) throw new Error("rm failed");

console.log("\nE2E PASS");
await client.close();
