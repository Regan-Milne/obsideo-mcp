// The channel label an install reports at signup.
//
// Guarded because getting this wrong is silent and expensive: on 2026-09-12 our
// own end-to-end run auto-provisioned with the same default source as a real
// customer's first `put`, and the signup alert announced it as a conversion.
// The separation has to happen at signup, so these two cases are load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";

const { defaultSource } = await import("../dist/config.js");

test("defaults to mcp so a real user is labelled by channel, not by us", () => {
  delete process.env.OBSIDEO_SOURCE;
  assert.equal(defaultSource(), "mcp");
});

test("OBSIDEO_SOURCE declares a run as ours at the moment the account is born", () => {
  process.env.OBSIDEO_SOURCE = "verify";
  assert.equal(defaultSource(), "verify");
  delete process.env.OBSIDEO_SOURCE;
});

test("blank or whitespace OBSIDEO_SOURCE falls back rather than sending an empty label", () => {
  process.env.OBSIDEO_SOURCE = "   ";
  assert.equal(defaultSource(), "mcp");
  delete process.env.OBSIDEO_SOURCE;
});

test("a Hermes client is attributed as source=hermes when no env is set", async () => {
  const { defaultSource, setClientName } = await import("../dist/config.js");
  delete process.env.OBSIDEO_SOURCE;
  setClientName("hermes-agent"); assert.equal(defaultSource(), "hermes");
  setClientName("Hermes Agent"); assert.equal(defaultSource(), "hermes");
  setClientName("claude-desktop"); assert.equal(defaultSource(), "mcp");
  process.env.OBSIDEO_SOURCE = "verify"; setClientName("hermes-agent");
  assert.equal(defaultSource(), "verify", "env wins over client name");
  delete process.env.OBSIDEO_SOURCE; setClientName("");
});

test("the server version is the package.json version", async () => {
  const { createRequire } = await import("node:module");
  const pkg = createRequire(import.meta.url)("../package.json");
  const src = (await import("node:fs")).readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.ok(!/version: "0\.\d+\.\d+"/.test(src), "no hardcoded version string in the server");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
