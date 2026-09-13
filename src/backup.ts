/**
 * backup_keys: put the credential directory somewhere the human chose.
 *
 * Everything that can decrypt the data lives in ~/.obsideo (mcp.json holds
 * the encryption key and account credentials; signing.pem the account
 * signing key; roots.json the upload commitments). Obsideo has no copy. The
 * first outside evaluator improvised this with tar on 2026-09-12 and took a
 * backup that predated the key; this tool makes the step explicit and
 * complete. The archive is written in-process (a minimal ustar + gzip), so
 * it works the same on Windows, macOS and Linux with no external tool.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { CONFIG_DIR, CONFIG_PATH, SIGNING_KEY_PATH, expandPath, loadConfig } from "./config.js";

const FILES = [CONFIG_PATH, SIGNING_KEY_PATH, join(CONFIG_DIR, "roots.json")];

/** Minimal ustar writer: enough for a few small regular files. */
function tarGz(entries: { name: string; data: Buffer; mode: number; mtime: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512, 0);
    h.write(e.name, 0, 100, "utf8");
    h.write(e.mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii"); // uid
    h.write("0000000\0", 116, 8, "ascii"); // gid
    h.write(e.data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    h.write(Math.floor(e.mtime / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii"); // checksum placeholder
    h.write("0", 156, 1, "ascii"); // regular file
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(h, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // end-of-archive
  return gzipSync(Buffer.concat(blocks));
}

export function backupKeys(destination?: string): string {
  const cfg = loadConfig();
  if (!cfg.account_token) {
    throw new Error("No Obsideo account is configured on this machine yet; there is nothing to back up.");
  }
  const present = FILES.filter((f) => existsSync(f));
  if (!present.includes(CONFIG_PATH)) throw new Error(`${CONFIG_PATH} is missing; nothing to back up.`);
  const stamp = new Date().toISOString().slice(0, 10);
  const target = destination
    ? expandPath(destination)
    : resolve(homedir(), `obsideo-keys-${cfg.account_id ?? "account"}-${stamp}.tar.gz`);
  const names = present.map((f) => basename(f)).join(", ");
  const warn = cfg.encryption_key
    ? ""
    : " NOTE: no encryption key exists on this account yet; take another backup after it is created.";
  const advice =
    " This is the only way to recover encrypted objects if this machine is lost; Obsideo has no copy." +
    " Tell your human to move it somewhere that survives this machine (another device, a password manager attachment, offline media).";

  if (/\.(tar\.gz|tgz)$/i.test(target)) {
    mkdirSync(resolve(target, ".."), { recursive: true });
    const archive = tarGz(
      present.map((f) => ({ name: `obsideo/${basename(f)}`, data: readFileSync(f), mode: 0o600, mtime: statSync(f).mtimeMs }))
    );
    writeFileSync(target, archive);
    return `Backed up ${present.length} files (${names}) to ${target} (${archive.length} bytes, gzip tar).${advice}${warn}`;
  }
  mkdirSync(target, { recursive: true });
  for (const f of present) copyFileSync(f, join(target, basename(f)));
  return `Copied ${present.length} files (${names}) into ${target}.${advice}${warn}`;
}
