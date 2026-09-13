# Obsideo for Claude Code

Encrypted offsite object storage, installed as a Claude Code plugin. Installing it
brings the `obsideo` MCP server with it — there is no separate `claude mcp add` step.

```
/plugin marketplace add Regan-Milne/obsideo-mcp
/plugin install obsideo@obsideo
```

That works today, straight from this repository. The same plugin is also submitted
to Anthropic's community marketplace; once it lands there, `obsideo@claude-community`
works too.

Or test it locally from a clone of this repo:

```
claude --plugin-dir ./claude-plugin
```

## What it gives Claude

| | |
|---|---|
| `offsite-backup` skill | Backs up files or a project, encrypting on this machine first |
| `verify-backup` skill | Asks the providers to prove they still hold the bytes, without downloading them |
| `backup-claude-setup` skill | Backs up this project's CLAUDE.md, skills, agents, hooks and settings — with credential files excluded |
| `obsideo` MCP server | 13 tools: `put`, `get`, `ls`, `rm`, `verify`, `usage`, `plan`, `backup_keys`, signup and billing |

## How it works

Objects are encrypted client-side before upload — the key is generated on your machine,
stored under `~/.obsideo`, and never sent to Obsideo. Ciphertext is replicated to three
independent storage providers, each continuously challenged to prove it still holds the
bytes. `verify` runs that challenge on demand, so you can test a cold copy without
paying egress to retrieve it.

It is object storage, not a database: it stores and returns whole objects by key.

**Your key is the only copy.** Run `backup_keys` after your first upload and keep the
result somewhere safe. Obsideo cannot recover your data without it, and neither can you.

## Free tier

A first `put` creates a trial account automatically: 100 MB, about a week, no email and
no card. Claiming it with an email moves the *same* account to 12 GB free with no
expiry — nothing is re-uploaded and no credentials change. Paid plans are self-serve
from a checkout link you open yourself; nothing resizes your plan without you.

## Links

- Runbook: <https://obsideo.io/agent-storage>
- MCP server source: <https://github.com/Regan-Milne/obsideo-mcp>
- npm: [`obsideo-mcp`](https://www.npmjs.com/package/obsideo-mcp)

The MCP server is licensed PolyForm Shield 1.0.0; see the repository root.
