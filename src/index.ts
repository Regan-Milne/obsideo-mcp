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
import { provisionTrial } from "./trial.js";
import { get, ls, put, rm, usage } from "./storage.js";
import { verifyObject } from "./verify.js";

const server = new McpServer({ name: "obsideo", version: "0.5.0" });

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
  "trial",
  {
    title: "Create an instant trial account (no email)",
    description:
      "Create a free Obsideo account with no email and no human in the loop: a small " +
      "proof-of-work and a ~10 second wait in place of identity. Returns a real account on " +
      "the production network (100 MB, about 7 days, RF=3 replication, continuous possession " +
      "proofs) and saves credentials locally. You usually do NOT need to call this: the first " +
      "put/get/ls/usage auto-creates a trial if no account is configured. Call it to provision " +
      "explicitly. To keep data beyond the trial, upgrade to the 12 GB email tier via signup_start.",
    inputSchema: {
      source: z.string().optional().describe("Where you found Obsideo (defaults to 'mcp')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ source }) => {
    try {
      const t = await provisionTrial(source);
      return text(
        `Trial account created: agent "${t.agent_name}", ${t.quota_mb} MB, expires ` +
          `${t.expires_at ?? "in ~7 days"}. Credentials saved locally under ~/.obsideo. ` +
          "Objects are encrypted client-side by default with a key generated on this machine " +
          "and held only here; back up ~/.obsideo/mcp.json or the data cannot be recovered. " +
          "This is a small, temporary account on the production network; to keep the data, " +
          "upgrade to the 12 GB free tier with an email via signup_start."
      );
    } catch (e) {
      return errText(e);
    }
  }
);

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
      "Store a local file or inline content as an object. ENCRYPTED BY DEFAULT: the bytes are " +
      "encrypted client-side with AES-256-GCM using a locally generated, user-held key before " +
      "they leave the machine, so the platform stores ciphertext it cannot read. The key lives " +
      "only in the local config file and Obsideo has no copy: if the user loses it the data is " +
      "unrecoverable, so tell them to back it up. Pass encrypt=false only when another tool must " +
      "read the stored bytes directly (S3 interop); that stores plaintext. Zero-byte objects are " +
      "rejected. Objects are replicated to 3 providers and verified on a continuous cryptographic " +
      "challenge cycle.",
    inputSchema: {
      key: z.string().describe("Object key, e.g. backups/db-2026-07-19.sql.zst"),
      local_path: z.string().optional().describe("Path of a local file to upload"),
      content: z.string().optional().describe("Inline UTF-8 content (alternative to local_path)"),
      encrypt: z
        .boolean()
        .optional()
        .describe("Defaults to true. Set false to store plaintext for S3 interop."),
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
      "Retrieve an object. Encrypted objects (the default for anything stored through this " +
      "server) are decrypted automatically with the local key; retrieval from a machine without " +
      "that key will fail, which is the intended property. Small text objects return inline; " +
      "pass local_path for anything else.",
    inputSchema: {
      key: z.string(),
      local_path: z.string().optional().describe("Save to this path instead of returning inline"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ key, local_path }) => {
    try {
      const r = await get(key, local_path);
      const note = r.note ?? "";
      if (r.saved_to)
        return text(note + `Saved ${r.bytes} bytes to ${r.saved_to}${r.encrypted ? " (decrypted)" : ""}.`);
      return text(note + r.text!);
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
  "verify",
  {
    title: "Prove an object is really stored (client-side)",
    description:
      "Independently verify that the network still holds an object, without downloading it. " +
      "Challenges each provider directly, recomputes the merkle root from your own copy of the " +
      "bytes, and checks each provider's cryptographic signature. Trusts nothing the coordinator " +
      "says for the verdict. Objects stored through this server verify at full strength with no " +
      "extra arguments, because their commitment was recorded locally at upload time. Pass " +
      "local_path (your copy of the stored file) to prove possession against a file on disk " +
      "instead. Returns how many providers proved possession right now and whether any returned " +
      "bad data.",
    inputSchema: {
      key: z.string().describe("Object key to verify, e.g. backups/db-2026-08-13.sql.zst"),
      local_path: z.string().optional().describe("Your local copy of the stored bytes (optional; only needed for objects this server did not upload)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ key, local_path }) => {
    try {
      const r = await verifyObject(key, local_path);
      const lines: string[] = [];
      lines.push(
        `${r.proved} of ${r.holders} providers proved possession of ${r.bucket}/${key} right now` +
          (r.signed ? ` (${r.signed} returned a valid cryptographic signature)` : "") + "."
      );
      if (r.rootSource === "local-file") {
        lines.push("Verified against the merkle root computed from YOUR local copy: they hold your exact bytes.");
      } else if (r.rootSource === "recorded") {
        lines.push(
          "Verified against the merkle root this machine computed when it uploaded the object: " +
            "they hold your exact bytes." +
            (r.encryptedObject
              ? " (The object is stored encrypted, so the stored bytes are ciphertext and will " +
                "never match a plaintext file on disk. This is the correct check for it.)"
              : "")
        );
      } else {
        lines.push(
          "Verified against the coordinator's recorded root only. This machine has no commitment " +
            "of its own for this object, so pass local_path to prove they hold YOUR bytes."
        );
      }
      for (const p of r.results) {
        if (p.pass) lines.push(`  ok    ${p.address}  ${p.ms}ms  proved + signed`);
        else if (p.older_node) lines.push(`  note  ${p.address}  older node without client-challenge (still serves the coordinator proof cycle; not a failure)`);
        else if (p.failed_proof) lines.push(`  ALARM ${p.address}  ${p.error}`);
        else lines.push(`  skip  ${p.address}  ${p.error ?? "not challenged"}`);
      }
      if (r.mismatch)
        lines.push("\nWARNING: a provider answered but failed the proof. This is a real integrity alarm, not a network hiccup. Investigate before trusting this object.");
      else if (r.proved === 0)
        lines.push("\nNo provider could be challenged this way right now. Not necessarily loss (could be older nodes or rate limits), but do not treat this object as verified.");
      lines.push("\nThis check trusted nothing the coordinator asserted: it went to the providers directly and checked the maths and signatures itself.");
      return text(lines.join("\n"));
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
