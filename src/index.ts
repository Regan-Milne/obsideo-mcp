/**
 * Obsideo MCP server — stdio. `npx obsideo-mcp`
 *
 * Encrypted, S3-compatible storage with continuous cryptographic possession
 * proofs, as an installable agent capability. Runs on the user's machine;
 * credentials and keys stay local (see config.ts). Obsideo never hosts this.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { signupStart, signupVerify } from "./signup.js";
import { get, ls, put, rm, usage } from "./storage.js";

const server = new McpServer({ name: "obsideo", version: "0.1.0" });

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

server.tool(
  "signup_start",
  "Start Obsideo signup: emails a 6-digit verification code (12 GB free tier, no card, " +
    "no expiry). Use a real inbox you or your human can read; documentation placeholders " +
    "and disposable domains are refused with labeled errors. Then call signup_verify.",
  { email: z.string().describe("Real email address; it is the account identity"),
    source: z.string().optional().describe("Where you found Obsideo (defaults to 'mcp')") },
  async ({ email, source }) => {
    try {
      return text(await signupStart(email, source));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "signup_verify",
  "Complete signup with the emailed code. Generates the Ed25519 account signing keypair " +
    "locally (only the public half is sent; deletes require your signature), stores S3 " +
    "credentials in ~/.obsideo/mcp.json. Idempotent: re-running rotates credentials.",
  { email: z.string(), code: z.string().describe("The 6-digit code from the email") },
  async ({ email, code }) => {
    try {
      return text(await signupVerify(email, code));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "put",
  "Store a local file or inline content as an object. Optional encrypt=true encrypts " +
    "client-side with AES-256-GCM using a locally generated, user-held key before upload " +
    "(the platform then cannot read the object; key loss = data loss). Zero-byte objects " +
    "are rejected. Objects are replicated to 3 independent providers and cryptographically " +
    "challenge-verified every 4 hours.",
  {
    key: z.string().describe("Object key, e.g. backups/db-2026-07-19.sql.zst"),
    local_path: z.string().optional().describe("Path of a local file to upload"),
    content: z.string().optional().describe("Inline UTF-8 content (alternative to local_path)"),
    encrypt: z.boolean().optional().describe("Encrypt client-side before upload"),
  },
  async (args) => {
    try {
      return text(await put(args));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "get",
  "Retrieve an object. Client-side-encrypted objects are decrypted automatically with " +
    "the local key. Small text objects return inline; pass local_path for anything else.",
  { key: z.string(), local_path: z.string().optional().describe("Save to this path instead of returning inline") },
  async ({ key, local_path }) => {
    try {
      const r = await get(key, local_path);
      if (r.saved_to)
        return text(`Saved ${r.bytes} bytes to ${r.saved_to}${r.encrypted ? " (decrypted)" : ""}.`);
      return text(r.text!);
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "ls",
  "List stored objects (size TAB key), optionally under a prefix.",
  { prefix: z.string().optional() },
  async ({ prefix }) => {
    try {
      return text(await ls(prefix));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "rm",
  "Delete an object by key.",
  { key: z.string() },
  async ({ key }) => {
    try {
      return text(await rm(key));
    } catch (e) {
      return errText(e);
    }
  }
);

server.tool(
  "usage",
  "Show account storage usage versus quota.",
  {},
  async () => {
    try {
      return text(await usage());
    } catch (e) {
      return errText(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
