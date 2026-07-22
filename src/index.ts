/**
 * Obsideo MCP server — stdio. `npx obsideo-mcp`
 *
 * Encrypted, S3-compatible storage with continuous cryptographic possession
 * proofs, as an installable agent capability. Runs on the user's machine;
 * credentials and keys stay local (see config.ts). Obsideo never hosts this.
 *
 * Every tool carries a title + readOnlyHint/destructiveHint annotation
 * (Connectors Directory requirement; annotations are honest, not aspirational:
 * `put` can overwrite an existing key, so it is marked destructive).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { signupStart, signupVerify } from "./signup.js";
import { get, ls, put, rm, usage } from "./storage.js";

const server = new McpServer({ name: "obsideo", version: "0.2.0" });

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

server.registerTool(
  "signup_start",
  {
    title: "Start Obsideo signup",
    description:
      "Start Obsideo signup: emails a 6-digit verification code (12 GB free tier, no card, " +
      "no expiry). Use a real inbox you or your human can read; documentation placeholders " +
      "and disposable domains are refused with labeled errors. Then call signup_verify.",
    inputSchema: {
      email: z.string().describe("Real email address; it is the account identity"),
      source: z.string().optional().describe("Where you found Obsideo (defaults to 'mcp')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ email, source }) => {
    try {
      return text(await signupStart(email, source));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "signup_verify",
  {
    title: "Complete Obsideo signup",
    description:
      "Complete signup with the emailed code. Generates the Ed25519 account signing keypair " +
      "locally (only the public half is sent), stores S3 " +
      "credentials in ~/.obsideo/mcp.json. Re-running rotates credentials and keypair " +
      "with no overlap; do not re-run to retry.",
    inputSchema: {
      email: z.string(),
      code: z.string().describe("The 6-digit code from the email"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ email, code }) => {
    try {
      return text(await signupVerify(email, code));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "put",
  {
    title: "Store an object",
    description:
      "Store a local file or inline content as an object. Optional encrypt=true encrypts " +
      "client-side with AES-256-GCM using a locally generated, user-held key before upload " +
      "(the platform then cannot read the object; key loss = data loss). Zero-byte objects " +
      "are rejected. Objects are replicated to 3 providers and verified on a continuous " +
      "cryptographic challenge cycle.",
    inputSchema: {
      key: z.string().describe("Object key, e.g. backups/db-2026-07-19.sql.zst"),
      local_path: z.string().optional().describe("Path of a local file to upload"),
      content: z.string().optional().describe("Inline UTF-8 content (alternative to local_path)"),
      encrypt: z.boolean().optional().describe("Encrypt client-side before upload"),
    },
    // destructiveHint true: writing to an existing key overwrites it.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      return text(await put(args));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get",
  {
    title: "Retrieve an object",
    description:
      "Retrieve an object. Client-side-encrypted objects are decrypted automatically with " +
      "the local key. Small text objects return inline; pass local_path for anything else.",
    inputSchema: {
      key: z.string(),
      local_path: z.string().optional().describe("Save to this path instead of returning inline"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
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

server.registerTool(
  "ls",
  {
    title: "List stored objects",
    description: "List stored objects (size TAB key), optionally under a prefix.",
    inputSchema: { prefix: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ prefix }) => {
    try {
      return text(await ls(prefix));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "rm",
  {
    title: "Delete an object",
    description: "Delete an object by key.",
    inputSchema: { key: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ key }) => {
    try {
      return text(await rm(key));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "usage",
  {
    title: "Show storage usage",
    description: "Show account storage usage versus quota.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
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
