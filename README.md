# Obsideo MCP server

Give any MCP-capable agent (Claude Desktop, Claude Code, Cursor, Cline, ...)
durable, encrypted, cryptographically verified storage. Self-serve signup from
inside the conversation: 12 GB free, no card, no CAPTCHA, no expiry.

[Obsideo](https://obsideo.io) is S3-compatible object storage where every
stored object is replicated to 3 independent providers and challenged with
chunk-level merkle proofs every 4 hours; providers are paid only for proofs
they pass. Paid tier: $15/TB-month, egress included.

## Privacy posture (read this first)

- **This server runs on YOUR machine.** Obsideo never hosts it. Credentials,
  the account signing key, and the optional encryption key live in
  `~/.obsideo/` and are sent nowhere except the endpoints they authenticate
  against.
- **The account signing key is generated locally**; only the public half is
  ever sent. Deletes on your account are authorized only by your signature,
  so the platform cannot destroy your data unilaterally.
- **Optional encrypt-first storage**: `put` with `encrypt: true` encrypts
  client-side (AES-256-GCM) with a locally generated, user-held key before
  upload. The platform then stores ciphertext it is architecturally incapable
  of reading. Key loss means those objects are unrecoverable; back up
  `~/.obsideo/mcp.json`.

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

## Tools

| Tool | What it does |
|---|---|
| `signup_start` | Email a 6-digit code (12 GB free tier; real inboxes only, refusals are labeled) |
| `signup_verify` | Complete signup; generates the signing keypair locally, stores credentials |
| `put` | Store a file or inline content; optional client-side encryption |
| `get` | Retrieve an object (auto-decrypts locally encrypted objects) |
| `ls` | List objects, optionally by prefix |
| `rm` | Delete an object |
| `usage` | Storage used vs quota |

A `verify_proofs` tool (per-object possession-proof status) will be added when
the customer proofs API ships.

## What it is good for

App file storage, automated backups (databases, snapshots, state), agent
artifacts and memory that must survive sessions and machines, provable offsite
copies. Not a CDN, not a queryable database, not sub-millisecond storage;
Obsideo stores objects and backup artifacts.

Full integration contract (per-step postconditions, error table):
[obsideo.io/agents.md](https://obsideo.io/agents.md)

## Verified

Every tool in this server was exercised end to end against the production
gateway before release, including an encrypted put/get roundtrip verified
hash-exact (sha256) and labeled-error passthrough from the signup service.

## License

MIT

## Privacy Policy

This extension runs entirely on your machine. Credentials, your account signing
key, and any client-side encryption key are stored locally in
`~/.obsideo/mcp.json` and are never sent to or hosted by Obsideo. Conversation
content from your AI assistant is not collected; only the tool calls you make
(for example an upload) reach the storage service.

Full policy: https://obsideo.io/privacy/
