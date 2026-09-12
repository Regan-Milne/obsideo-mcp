// Direct transport against a mock coordinator + mock provider.
// Run: npm run build && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}
function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

test("put: register -> provider upload -> confirm; get returns the bytes; list; delete", async () => {
  const stored = new Map(); // merkle -> bytes on the mock provider
  const log = [];
  const provider = await listen(async (req, res) => {
    log.push(`P ${req.method} ${req.url} auth=${req.headers.authorization}`);
    const m = req.url.match(/^\/upload\/([0-9a-f]+)\?/);
    if (req.method === "POST" && m) {
      stored.set(m[1], await body(req));
      res.writeHead(200); res.end("{}"); return;
    }
    const d = req.url.match(/^\/download\/([0-9a-f]+)$/);
    if (req.method === "GET" && d && req.headers.authorization === "Bearer dl-tok") {
      res.writeHead(200); res.end(stored.get(d[1])); return;
    }
    res.writeHead(404); res.end();
  });
  let bucketCreated = false;
  let confirmed = null;
  const coord = await listen(async (req, res) => {
    log.push(`C ${req.method} ${req.url} auth=${req.headers.authorization}`);
    if (req.headers.authorization !== "Bearer obs_acct_key") { res.writeHead(401); res.end(); return; }
    if (req.method === "PUT" && req.url === "/v1/buckets/mlvault") { bucketCreated = true; res.writeHead(201); res.end("{}"); return; }
    if (req.method === "PUT" && req.url.startsWith("/v1/buckets/mlvault/objects/")) {
      if (!bucketCreated) { res.writeHead(404); res.end('{"error":"bucket not found"}'); return; }
      const reg = JSON.parse((await body(req)).toString());
      assert.equal(reg.encryption, "external");
      assert.equal(reg.chunk_size, 1048576);
      assert.equal(reg.chunk_hashes.length, reg.chunk_count);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ merkle_root: reg.merkle_root, providers: [
        { provider_id: "p1", address: provider.url, upload_token: "up-tok" },
      ] }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/internal/uploads/")) {
      confirmed = JSON.parse((await body(req)).toString());
      res.writeHead(200); res.end("{}"); return;
    }
    if (req.method === "GET" && req.url === "/v1/buckets/mlvault/objects/hello.txt") {
      const root = confirmed?.__root;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ merkle_root: [...stored.keys()][0], provider_url: provider.url, download_token: "dl-tok", size_bytes: 5 }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v1/buckets/mlvault/objects")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ objects: [{ key: "hello.txt", size_bytes: 5, proof_status: "verified" }] }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/v1/buckets/mlvault/objects/hello.txt") { res.writeHead(204); res.end(); return; }
    res.writeHead(500); res.end("unexpected " + req.method + " " + req.url);
  });

  process.env.OBSIDEO_COORDINATOR_URL = coord.url;
  const direct = await import("../dist/direct.js");
  const cfg = { api_key: "obs_acct_key", account_id: "trial-x", bucket: "mlvault" };
  const data = Buffer.from("hello");

  const r = await direct.putDirect(cfg, "hello.txt", data);
  assert.equal(r.providers, 1);
  assert.equal(r.placed, 1);
  assert.ok(bucketCreated, "404 on register must trigger ensureBucket and retry");
  assert.deepEqual(confirmed, { account_id: "trial-x", bucket: "mlvault", key: "hello.txt", providers: ["p1"], ack: true });
  assert.equal(stored.get(r.root)?.toString(), "hello", "provider received the exact bytes under the merkle root");
  assert.ok(log.some((l) => l.startsWith(`P POST /upload/${r.root}?owner=mcp&start=0&chunk_size=1048576&proof_type=0 auth=Bearer up-tok`)), log.join("\n"));

  const got = await direct.getDirect(cfg, "hello.txt");
  assert.equal(got.toString(), "hello");

  const ls = await direct.listDirect(cfg, "he");
  assert.deepEqual(ls.map((o) => o.key), ["hello.txt"]);

  await direct.deleteDirect(cfg, "hello.txt");
  assert.ok(log.some((l) => l.startsWith("C DELETE /v1/buckets/mlvault/objects/hello.txt")));

  coord.srv.close(); provider.srv.close();
});

test("commitment matches the reference tree shape (1 chunk => root = leaf)", async () => {
  const direct = await import("../dist/direct.js");
  const data = Buffer.from("hello");
  const { root, chunkHashes } = direct.commitment(data);
  const ch = createHash("sha256").update(Buffer.from("0" + data.toString("hex"), "ascii")).digest();
  const leaf = createHash("sha3-512").update(ch).digest();
  assert.equal(chunkHashes.length, 1);
  assert.equal(chunkHashes[0], ch.toString("hex"));
  assert.equal(root, leaf.toString("hex"));
});

test("requires api_key/account_id/bucket, names the escape hatch", async () => {
  const direct = await import("../dist/direct.js");
  await assert.rejects(() => direct.listDirect({ bucket: "mlvault" }), /OBSIDEO_TRANSPORT=s3/);
});
