import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isEncrypted } from "../dist/crypto.js";
const cfg = JSON.parse(readFileSync(join(process.env.OBSIDEO_MCP_HOME ?? join(homedir(), ".obsideo"), "mcp.json"), "utf8"));
const c = new S3Client({ endpoint: cfg.endpoint, region: cfg.region || "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: cfg.access_key, secretAccessKey: cfg.secret_key } });
const r = await c.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: process.env.KEY ?? "hermes/proof.txt" }));
const b = Buffer.from(await r.Body.transformToByteArray());
const printable = b.filter(x => x >= 32 && x < 127).length / b.length;
console.log(`account ${cfg.account_id}: raw object ${b.length} bytes, isEncrypted=${isEncrypted(b)}, printable-ratio=${printable.toFixed(2)}, first bytes hex=${b.subarray(0,8).toString("hex")}`);
