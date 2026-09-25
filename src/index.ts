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
import { provisionTrial, refuseIfConfigured } from "./trial.js";
import { get, ls, put, rm, usage } from "./storage.js";
import { trustNote, verifyObject } from "./verify.js";
import { plan, portal, upgrade } from "./billing.js";
import { reporterFrom, withReporter } from "./progress.js";
import { backupKeys } from "./backup.js";

import { createRequire } from "node:module";
import { setClientName } from "./config.js";
// Version comes from package.json so the handshake can never drift from the
// published package again (0.7.1 on npm announced itself as 0.6.4).
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "obsideo", version: pkg.version });

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
      "explicitly. To keep data beyond the trial, claim it with an email via signup_start " +
      "(same account and data, quota rises to 12 GB). Takes about 15 to 30 seconds (proof of work " +
      "plus a 10 second issuance window); progress is reported while it runs.",
    inputSchema: {
      source: z.string().optional().describe("Where you found Obsideo (defaults to 'mcp')"),
      replace: z
        .boolean()
        .optional()
        .describe(
          "Only if the human explicitly wants a fresh, separate account: replace the account already " +
            "configured on this machine. Without it, this tool refuses when an account exists."
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ source, replace }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      refuseIfConfigured(replace ?? false);
      const t = await provisionTrial(source);
      return text(
        `Trial account created: agent "${t.agent_name}", ${t.quota_mb} MB, expires ` +
          `${t.expires_at ?? "in ~7 days"}. Credentials saved locally under ~/.obsideo. ` +
          "The encryption key was generated with the account and is held only on this machine; " +
          "call backup_keys now, or the data cannot be recovered if this machine is lost. " +
          "This is a small, temporary account on the production network; to keep the data, " +
          "claim it with an email via signup_start (12 GB free, same account, nothing moves)."
      );
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "signup_start",
  {
    title: "Start Obsideo signup (or claim the trial)",
    description:
      "Start Obsideo signup: emails a 6-digit verification code (12 GB free tier, no card, " +
      "no expiry). If a no-email trial is configured on this machine, this CLAIMS it in place: " +
      "same account, bucket, keys and data, only the quota rises. Otherwise it creates a new " +
      "account for the email. Use a real inbox you or your human can read; documentation " +
      "placeholders and disposable domains are refused with labeled errors. Then call signup_verify.",
    inputSchema: {
      email: z.string().describe("Real email address; it is the account identity"),
      source: z.string().optional().describe("Where you found Obsideo (defaults to 'mcp')"),
      abandon_trial: z
        .boolean()
        .optional()
        .describe(
          "Only when the email already has its own account (email_in_use): sign in to that account " +
            "instead of claiming; the trial and its data are left behind."
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ email, source, abandon_trial }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await signupStart(email, source, abandon_trial ?? false));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "signup_verify",
  {
    title: "Complete Obsideo signup",
    description:
      "Complete signup with the emailed code. When claiming a trial, nothing but the quota and " +
      "the identity changes (credentials stay valid, no propagation wait). For a new account, " +
      "generates the Ed25519 account signing keypair locally (only the public half is sent) and " +
      "stores S3 credentials in ~/.obsideo/mcp.json; re-running that path rotates credentials " +
      "and keypair with no overlap, so do not re-run to retry.",
    inputSchema: {
      email: z.string(),
      code: z.string().describe("The 6-digit code from the email"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ email, code }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await signupVerify(email, code));
    } catch (e) {
      return errText(e);
    }
  })
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
      "challenge cycle. The first call on a fresh machine also creates the account and can take 20 to " +
      "50 seconds; progress is reported while it runs. Encrypted objects are readable only with this " +
      "machine's key: there is no cross-user sharing of encrypted objects.",
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
  async (args, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await put(args));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "get",
  {
    title: "Retrieve an object",
    description:
      "Retrieve an object. Encrypted objects (the default for anything stored through this " +
      "server) are decrypted automatically with the local key; retrieval from a machine without " +
      "that key will fail, which is the intended property. Small text objects return inline; " +
      "pass local_path for anything else. WRITES TO DISK: passing local_path writes the bytes " +
      "to that path and overwrites any existing file there, so treat it as a write operation " +
      "and confirm the path with your human first.",
    inputSchema: {
      key: z.string(),
      local_path: z
        .string()
        .optional()
        .describe("Save to this path instead of returning inline. Overwrites an existing file."),
    },
    // Not read-only: with local_path this writes to the local filesystem and overwrites.
    // Clients use readOnlyHint to decide what may run without asking, so claiming it here
    // removed the prompt in front of an arbitrary file write. Found during an outside
    // agent review of the consent surface, 2026-09-21.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ key, local_path }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      const r = await get(key, local_path);
      const note = r.note ?? "";
      if (r.saved_to)
        return text(note + `Saved ${r.bytes} bytes to ${r.saved_to}${r.encrypted ? " (decrypted)" : ""}.`);
      return text(note + r.text!);
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "ls",
  {
    title: "List stored objects",
    description: "List stored objects (size TAB key), optionally under a prefix.",
    inputSchema: { prefix: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ prefix }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await ls(prefix));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "rm",
  {
    title: "Delete an object",
    description: "Delete an object by key.",
    inputSchema: { key: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ key }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await rm(key));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "verify",
  {
    title: "Prove an object is really stored (client-side)",
    description:
      "Independently verify that the network still holds an object, without downloading it. " +
      "Challenges each provider directly and compares every answer, on this machine, against a " +
      "merkle root. For objects stored through this server, that root is the one this machine " +
      "recorded at upload time, if the local record still has it. Pass local_path (your copy of " +
      "the stored file) to compare against a root computed from that file instead. If neither is " +
      "available, it falls back to the coordinator's recorded root and says so. The coordinator " +
      "chooses which providers to ask, where to reach them, and the public keys their signatures " +
      "are checked against. Returns how many providers proved possession right now, how many of " +
      "those answers were signed, and whether any returned bad data.",
    inputSchema: {
      key: z.string().describe("Object key to verify, e.g. backups/db-2026-08-13.sql.zst"),
      local_path: z.string().optional().describe("Your local copy of the stored bytes (optional; only needed for objects this server did not upload)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ key, local_path }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      const r = await verifyObject(key, local_path);
      const lines: string[] = [];
      lines.push(
        `${r.proved} of ${r.holders} providers proved possession of ${key} right now` +
          (r.signed ? ` (${r.signed} returned a valid cryptographic signature)` : "") + "."
      );
      // Say what the answers were compared against, never whether they passed:
      // the count above and the note below carry the verdict. Through 0.7.4 these
      // lines claimed the providers held the user's bytes even at 0 of N.
      if (r.rootSource === "local-file") {
        lines.push("Compared against: a merkle root computed from your local file.");
      } else if (r.rootSource === "recorded") {
        lines.push(
          "Compared against: the merkle root this machine recorded when it uploaded the object." +
            (r.encryptedObject
              ? " The object is stored encrypted, so that root is of the ciphertext, which will " +
                "never match a plaintext file on disk. This is the correct check for it."
              : "")
        );
      } else {
        lines.push(
          "Compared against: the coordinator's recorded root, because this machine has no " +
            "commitment of its own for this object. Pass local_path to compare against your own copy."
        );
      }
      for (const p of r.results) {
        if (p.pass) lines.push(`  ok    ${p.address}  ${p.ms}ms  ${p.signed ? "proved + signed" : "proved, unsigned (no public key listed for this provider)"}`);
        else if (p.older_node) lines.push(`  note  ${p.address}  older node without client-challenge (still serves the coordinator proof cycle; not a failure)`);
        else if (p.failed_proof) lines.push(`  ALARM ${p.address}  ${p.error}`);
        else lines.push(`  skip  ${p.address}  ${p.error ?? "not challenged"}`);
      }
      if (r.mismatch)
        lines.push("\nWARNING: a provider answered but failed the proof. This is a real integrity alarm, not a network hiccup. Investigate before trusting this object.");
      else if (r.proved === 0)
        lines.push("\nNo provider could be challenged this way right now. Not necessarily loss (could be older nodes or rate limits), but do not treat this object as verified.");
      const note = trustNote(r);
      if (note) lines.push("\n" + note);
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "usage",
  {
    title: "Show storage usage",
    description: "Show account storage usage versus quota.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (_args, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await usage());
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "plan",
  {
    title: "Show the paid plan",
    description:
      "Show the account's plan: free tier or paid blocks (200 GB per block, $5/month each), " +
      "status, period end, and any upgrade offer waiting for the human's agreement. Never " +
      "changes anything and never contacts Stripe.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (_args, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await plan());
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "upgrade",
  {
    title: "Get a checkout link for a paid plan",
    description:
      "Get a Stripe-hosted checkout link for a paid plan of N x 200 GB blocks at $5/month per " +
      "block. This tool charges NOTHING and changes nothing: the human opens the link and pays " +
      "on Stripe's page, and the quota rises after payment. Call it only when the human has " +
      "asked for more space, and hand the link back to them; do not open or submit it yourself. " +
      "If the account already has a paid plan this returns the plan instead (plan size is never " +
      "changed from here; only the human's click on Obsideo's emailed agree link does that).",
    inputSchema: {
      blocks: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of 200 GB blocks (default 1)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ blocks }, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await upgrade(blocks ?? 1));
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "portal",
  {
    title: "Get the billing portal link",
    description:
      "Get the Stripe Customer Portal link for a paid plan: cancel, change card, download " +
      "invoices. For the human to open. Cancelling keeps everything stored and readable; the " +
      "account returns to its free quota at the end of the paid period.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (_args, extra) => withReporter(reporterFrom(extra), async () => {
    try {
      return text(await portal());
    } catch (e) {
      return errText(e);
    }
  })
);

server.registerTool(
  "backup_keys",
  {
    title: "Back up the credentials and encryption key",
    description:
      "Copy everything needed to recover this account's data (credentials, account signing key, " +
      "encryption key, upload commitments) to a path the human names. Obsideo holds no copy of " +
      "the encryption key: if the local file is lost, encrypted objects are unrecoverable no matter " +
      "how many providers hold them. Call this once right after the account is created and again " +
      "after any signup that rotates keys. A .tar.gz path produces one archive; a directory path " +
      "produces plain copies; no path produces an archive in the home directory.",
    inputSchema: {
      destination: z
        .string()
        .optional()
        .describe("Archive path ending in .tar.gz, or a directory; defaults to ~/obsideo-keys-<account>-<date>.tar.gz"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ destination }) => {
    try {
      return text(backupKeys(destination));
    } catch (e) {
      return errText(e);
    }
  }
);

const transport = new StdioServerTransport();
// After initialize, remember who the client is: a Hermes install that came
// through the Nous catalog cannot set OBSIDEO_SOURCE, so the client name is the
// only attribution signal the shim can receive.
server.server.oninitialized = () => setClientName(server.server.getClientVersion()?.name ?? "");
await server.connect(transport);
