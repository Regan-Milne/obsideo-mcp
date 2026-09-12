# Obsideo MCP server

Give any MCP-capable agent (Claude Desktop, Claude Code, Cursor, Cline, ...)
durable storage that is encrypted on your machine before it is uploaded and
that you can independently prove is still held. Zero setup: the first
`put`/`get`/`ls` auto-creates a free no-email trial account (100 MB, proof-of-work
instead of identity), so storage just works with nothing to configure. Want more?
Self-serve signup from inside the conversation upgrades to 12 GB free, no card,
no CAPTCHA, no expiry.

[Obsideo](https://obsideo.io) is S3-compatible object storage where every
stored object is replicated to 3 providers and challenged with chunk-level
merkle proofs on a continuous cycle; providers are paid only for proofs
they pass. 12 GB free with an email, no card. Paid plans are 200 GB blocks at
$5/month each by card (Stripe), started from the `upgrade` tool and paid on
Stripe's own page; the plan never changes size without the human's agreement.

## Privacy posture (read this first)

- **This server runs on YOUR machine.** Obsideo never hosts it. Credentials,
  the account signing key, and the encryption key live in `~/.obsideo/` and are
  sent nowhere except the endpoints they authenticate against.
- **The account signing key is generated locally**; only the public half is
  ever sent. Keep `~/.obsideo/signing.pem` private. Re-running signup rotates
  credentials and the keypair with no overlap, so do not re-run casually.
- **Encrypted by default.** `put` encrypts client-side (AES-256-GCM) with a
  locally generated, user-held key before anything leaves the machine, so the
  platform stores ciphertext it is architecturally incapable of reading. Pass
  `encrypt: false` only when another tool must read the stored bytes directly
  (S3 interop).

### Back up your key

The encryption key is generated on your machine on first use and written to
`~/.obsideo/mcp.json`. **Obsideo does not have a copy and cannot recover it.**
If that file is lost, every encrypted object is permanently unreadable, no
matter how many providers still hold it and how many proofs it passes.
Replication protects against providers losing your bytes; it does not protect
against you losing your key. Back up `~/.obsideo/mcp.json` somewhere you would
still have after losing this machine.

`~/.obsideo/roots.json` is written alongside it: the merkle root of each object
as committed at upload time. It holds no secrets, and it is what lets `verify`
prove providers hold *your* bytes without re-uploading them. Encryption uses a
fresh IV per upload, so ciphertext cannot be recomputed from a plaintext file
later; this record is what keeps the strong proof available for encrypted
objects. Losing it costs you strength of proof, not data.

## Install

**Claude Desktop, one click:** download
[`obsideo-mcp.mcpb`](https://github.com/Regan-Milne/obsideo-mcp/releases/latest/download/obsideo-mcp.mcpb)
from the [latest release](https://github.com/Regan-Milne/obsideo-mcp/releases/latest),
then Settings -> Extensions and drag the file in. No Node or npm setup needed.

**Everything else, via npx:**

```json
{
  "mcpServers": {
    "obsideo": {
      "command": "npx",
      "args": ["-y", "obsideo-mcp"]
    }
  }
}
```

(Claude Desktop: `claude_desktop_config.json`. Claude Code:
`claude mcp add obsideo -- npx -y obsideo-mcp`. Cursor/Cline: their MCP
settings, same command.)

**Hermes Agent:** paste `https://obsideo.io/agent-storage` to your Hermes and say "set
this up". That page is a runbook the agent executes: install, first store, first
proof, then the free 12 GB tier with your email. The install it runs is one
command on any OS (Node 18 or newer is required for `npx`):

```bash
hermes mcp add obsideo --command npx --args -y obsideo-mcp
```

It writes the server into Hermes's own config, connects, lists the 12 tools and
asks which to enable (leave out `rm` if you would rather the agent had no delete
tool). Then `/reload-mcp` in a running session, or start a new one. The tools
appear as `mcp_obsideo_put`, `mcp_obsideo_get`, `mcp_obsideo_verify` and so on.
Manual alternative: the same `mcpServers` block as above, under the
`mcp_servers:` key of Hermes's `config.yaml`. First thing to try: ask Hermes to
store its own MEMORY.md on obsideo, then to verify it.

## Tools

| Tool | What it does |
|---|---|
| `trial` | Create an instant no-email account (100 MB, ~7 days, proof-of-work, no human needed). Usually unnecessary: storage tools auto-create one on first use |
| `signup_start` | Email a 6-digit code (12 GB free tier; real inboxes only, refusals are labeled). With a trial configured this **claims it in place**: same account, keys and data, quota rises |
| `signup_verify` | Complete signup or the claim. A new account generates the signing keypair locally and stores credentials; a claim changes nothing but the quota |
| `put` | Store a file or inline content, encrypted client-side by default (`encrypt: false` opts out). Auto-creates a trial account if none is configured |
| `get` | Retrieve an object (auto-decrypts with the local key) |
| `ls` | List objects, optionally by prefix |
| `rm` | Delete an object |
| `verify` | Prove the network still holds an object, without downloading it |
| `usage` | Storage used vs quota, plus the plan line |
| `plan` | Free tier or paid blocks, status, period end, any offer waiting for the human |
| `upgrade` | Stripe checkout link for N x 200 GB blocks. Charges nothing; the human pays on Stripe's page. Never changes an existing plan |
| `portal` | Stripe portal link: cancel, change card, invoices |

### Paying, and what an agent is allowed to do

`upgrade` returns a link. That is all it does. The human opens it, sees the exact
monthly amount, and pays or closes the tab; the quota rises after payment. An
existing plan is never resized from this server: near the top of a tier Obsideo
emails an agree link, and the human's click is the only thing that changes the
bill. `portal` returns the Stripe portal link for cancelling, changing the card
and downloading invoices. Cancelling keeps everything stored and readable; the
account returns to its free quota at the end of the paid period.

### `verify`

Challenges every provider holding the object directly, recomputes the merkle
root, and checks each provider's Ed25519 signature. It asks the coordinator only
*where* to go; nothing the coordinator asserts is trusted for the verdict. For
objects this server uploaded, it verifies against the commitment recorded
locally at upload time, so the answer is "they hold *my* bytes" rather than
"they agree with each other". Objects uploaded elsewhere can be verified by
passing `local_path`.

## What it is good for

App file storage, automated backups (databases, snapshots, state), agent
artifacts and memory that must survive sessions and machines, provable offsite
copies. Not a CDN, not a queryable database, not sub-millisecond storage;
Obsideo stores objects and backup artifacts.

Full integration contract (per-step postconditions, error table):
[obsideo.io/agents.md](https://obsideo.io/agents.md)

## Transport

From 0.7.0, `put` / `get` / `ls` / `rm` talk to the coordinator and to the
storage providers it names, the same path `verify` has always used. There is
no S3 gateway hop and no wait for freshly minted credentials to propagate: the
account's coordinator API key is valid the moment signup returns, so the first
`put` after signup works at once (measured 0.8 s on production). Configs that
predate the coordinator key, or `OBSIDEO_TRANSPORT=s3`, keep using the S3
gateway with the SigV4 keypair; nothing about stored objects changes between
the two, and the same S3 credentials still work with rclone, boto3 and any
other S3 client.

## Verified

Every tool in this server is exercised end to end against production before
release: a freshly minted trial, then an encrypted put / byte-exact get / ls /
rm over the direct transport (`test/e2e_prod.mjs`, which identifies itself so
it is excluded from funnel measurement), plus labeled-error passthrough from
the signup service. Unit tests run the transport against mock coordinator and
provider servers (`npm test`).

## License

PolyForm Shield 1.0.0 from version 0.6.2 (see `LICENSE`). In plain terms: you may
use, read, audit, modify and redistribute this server for any purpose except
building a product or service that competes with Obsideo. That keeps the
client auditable, which the product depends on, without handing the work to a
competitor. Versions 0.6.1 and earlier remain under MIT as published. The
storage provider node (`obsideo-provider`) is and stays MIT.

## Privacy Policy

This extension runs entirely on your machine. Credentials, your account signing
key, and any client-side encryption key are stored locally in
`~/.obsideo/mcp.json` and are never sent to or hosted by Obsideo. Conversation
content from your AI assistant is not collected; only the tool calls you make
(for example an upload) reach the storage service.

Full policy: https://obsideo.io/privacy/
