# Hermes catalog entry (prepared, not submitted)

`manifest.yaml` is the Obsideo entry for the Nous-approved MCP catalog shipped
with [Hermes Agent](https://github.com/NousResearch/hermes-agent). Hermes is an
open (MIT) agent framework that supports MCP plus a local OpenAI-compatible
model, so `obsideo-mcp` drops in with no adapter.

## How the catalog works

Entries live one directory per server under `optional-mcps/` in the hermes-agent
repo, each a single `manifest.yaml`. There is no self-serve tier: **entries are
merged by Nous staff via PR review.** The catalog is browsable from the Hermes
web dashboard and CLI with one-click install.

## To submit

1. Publish the pinned version to npm first. The manifest pins an exact version
   (`obsideo-mcp@0.5.0`) rather than floating, so a catalog install never
   changes what it runs when we publish a release. That version must exist
   before the entry can be reviewed.
2. Fork `NousResearch/hermes-agent`, add this file at
   `optional-mcps/obsideo/manifest.yaml`, open the PR.
3. Bumping the pinned version later is its own PR against the manifest.

## Notes for review

The catalog's 20 existing entries are all established SaaS brands (Stripe,
Notion, Linear, Supabase, Figma, ...) and there is **no storage or backup entry
at all**, which is the opening. The two things a reviewer will reasonably stop
on are handled explicitly in `post_install`:

- **It provisions an account by itself.** First storage call creates a free
  no-email trial. That is the zero-setup property and also the thing a reviewer
  should be told plainly, along with the `OBSIDEO_NO_AUTO_TRIAL=1` opt-out.
- **`rm` is pruned from `tools.default_enabled`**, following the precedent set
  by the `n8n` entry: a casual install should not arrive with an irreversible
  delete. Users can opt into it from the install-time checklist.
