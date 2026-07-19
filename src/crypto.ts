/**
 * Optional encrypt-first layer — AES-256-GCM, key generated locally and
 * user-held (~/.obsideo/mcp.json). With encrypt on, the platform stores
 * ciphertext it is architecturally incapable of reading; key loss = data
 * loss, which is the honest price of that property.
 *
 * Wire format: "OBSMCP1\0" magic | 12-byte IV | ciphertext | 16-byte GCM tag.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("OBSMCP1\0", "latin1");

export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

export function encrypt(plain: Buffer, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function isEncrypted(data: Buffer): boolean {
  return data.length > MAGIC.length + 28 && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decrypt(data: Buffer, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(MAGIC.length + 12, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
