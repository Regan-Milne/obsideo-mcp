// A failed signup_verify must leave signing.pem and mcp.json exactly as they
// were.
//
// Through 0.7.5 the new account signing key was written to signing.pem before
// /v1/auth/verify was even called, so a wrong code, a timeout or a 500 left the
// old credentials paired with a key the server had never seen (bridge #8).
//
// Adapted from Ari's test in obsideo-agent-bridge PR #13: same contract, driven
// through the real built server over MCP stdio as his was, but against a mock
// in this process and a fresh temporary home instead of his review sandbox.
// Added beyond his one case (see the PR's known limits): a dropped connection,
// a fresh install that must not be left with a stray key, and the success path,
// so a "fix" that never writes the key cannot pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "dist", "index.js");
const GUARD = pathToFileURL(path.join(HERE, "support", "loopback_guard.mjs")).href;

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Loopback-only stand-in for the signup service's /v1/auth/verify. */
async function mockSignup(mode) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString() || "{}";
      seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "POST" && req.url === "/v1/auth/verify") {
        if (mode === "500") return json(500, { error: "mock: forced failure" });
        if (mode === "drop") return req.socket.destroy();
        return json(200, {
          account_id: "acct-new", account_token: "tok-new", api_key: "key-new", endpoint: "http://127.0.0.1:1",
          region: "mock", bucket: "bkt-new", access_key: "AKnew", secret_key: "SKnew", quota_gb: 12, account_exists: false,
        });
      }
      json(404, { error: "mock: unhandled " + req.method + " " + req.url });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

async function signupVerify(home, signupUrl) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", GUARD, ENTRY],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      OBSIDEO_MCP_HOME: path.join(home, ".obsideo"),
      OBSIDEO_SIGNUP_URL: signupUrl,
      OBSIDEO_COORDINATOR_URL: signupUrl,
      OBSIDEO_SOURCE: "test",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "signup-verify-state-test", version: "1" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "signup_verify", arguments: { email: "prior@example.invalid", code: "000000" } });
  } finally {
    await client.close();
  }
}

/** A temporary home holding an existing account (or, with fresh, only a pending signup). */
function makeHome({ fresh = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsideo-signup-verify-"));
  const dir = path.join(root, ".obsideo");
  fs.mkdirSync(dir, { recursive: true });
  const cfg = fresh
    ? { pending_signup_mode: "auth" }
    : {
        email: "prior@example.invalid", pending_signup_mode: "auth", account_id: "acct-old", account_token: "tok-old",
        api_key: "key-old", endpoint: "http://127.0.0.1:1", region: "mock", bucket: "bkt-old",
        access_key: "AKold", secret_key: "SKold", encryption_key: "0".repeat(64),
      };
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(cfg, null, 2) + "\n");
  if (!fresh) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(path.join(dir, "signing.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
  }
  return { root, dir, pem: path.join(dir, "signing.pem"), cfg: path.join(dir, "mcp.json") };
}

const text = (resp) => (resp.content ?? []).map((c) => c.text ?? "").join("\n");

for (const [mode, label] of [["500", "the server answers HTTP 500"], ["drop", "the connection drops"], ["refused", "nothing is listening"]]) {
  test(`existing account: signing.pem and mcp.json unchanged when ${label}`, async () => {
    const h = makeHome();
    const before = { pem: sha256(h.pem), cfg: sha256(h.cfg) };
    const mock = await mockSignup(mode);
    const url = mode === "refused" ? await closedPort() : mock.url;
    try {
      const resp = await signupVerify(h.root, url);
      assert.equal(resp.isError, true, "verify must report the failure");
      if (mode === "500") assert.match(text(resp), /HTTP 500/);
      assert.equal(sha256(h.pem), before.pem, "failed signup_verify replaced signing.pem");
      assert.equal(sha256(h.cfg), before.cfg, "failed signup_verify changed mcp.json");
      assert.ok(!fs.existsSync(h.pem + ".new"), "left a half-written key beside signing.pem");
    } finally {
      mock.srv.close();
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });
}

test("fresh install: a failed verify leaves no stray signing key behind", async () => {
  const h = makeHome({ fresh: true });
  const beforeCfg = sha256(h.cfg);
  const mock = await mockSignup("500");
  try {
    const resp = await signupVerify(h.root, mock.url);
    assert.equal(resp.isError, true);
    assert.ok(!fs.existsSync(h.pem), "a key the server never accepted was written to signing.pem");
    assert.ok(!fs.existsSync(h.pem + ".new"));
    assert.equal(sha256(h.cfg), beforeCfg);
  } finally {
    mock.srv.close();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("success: the key on disk is the one the server accepted, saved with the new credentials", async () => {
  const h = makeHome();
  const oldPem = sha256(h.pem);
  const mock = await mockSignup("ok");
  try {
    const resp = await signupVerify(h.root, mock.url);
    assert.ok(!resp.isError, text(resp));
    assert.notEqual(sha256(h.pem), oldPem, "the key should have rotated");
    const sent = mock.seen.find((r) => r.url === "/v1/auth/verify").body.customer_signing_public_key;
    const der = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(h.pem))).export({ format: "der", type: "spki" });
    assert.equal(sent, "obk_sig_" + der.subarray(der.length - 32).toString("base64url"));
    const cfg = JSON.parse(fs.readFileSync(h.cfg, "utf8"));
    assert.equal(cfg.account_id, "acct-new");
    assert.equal(cfg.api_key, "key-new");
    assert.equal(cfg.encryption_key, "0".repeat(64), "the existing encryption key must be kept");
    assert.equal(cfg.pending_signup_mode, undefined);
    assert.ok(!fs.existsSync(h.pem + ".new"));
  } finally {
    mock.srv.close();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

/** A loopback URL with nothing listening on it. */
async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}
