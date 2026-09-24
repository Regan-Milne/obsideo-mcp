// What a verify result claims the verdict rested on.
//
// Guarded because it is the one sentence an agent reads to decide how far to
// trust the check. Through 0.7.3 it said "trusted nothing the coordinator
// asserted" on every result, including when the root came from the coordinator
// and when no provider answered. Even at full strength the coordinator supplies
// the provider list and signing keys, so the claim was never true as written.
import { test } from "node:test";
import assert from "node:assert/strict";

const { trustNote } = await import("../dist/verify.js");

const pass = { provider_id: "p1", address: "https://p1", pass: true, signed: true };
const failed = { provider_id: "p2", address: "https://p2", pass: false, signed: false, failed_proof: true };
const skipped = { provider_id: "p3", address: "https://p3", pass: false, signed: false, error: "rate limited" };
const older = { provider_id: "p4", address: "https://p4", pass: false, signed: false, older_node: true };

test("strong check: possession proven locally, provider names rely on the listing", () => {
  const note = trustNote({ strong: true, results: [pass] });
  assert.match(note, /Possession was proven on this machine/);
  assert.match(note, /your own bytes/);
  assert.match(note, /No Obsideo server takes part in that check/);
  // The two questions must stay separate: the key listing affects names, not possession.
  assert.match(note, /provider names rely on that listing/);
  assert.match(note, /The possession does not/);
});

test("coordinator root: says so, and does not claim it matches your copy", () => {
  const note = trustNote({ strong: false, results: [pass] });
  assert.match(note, /coordinator's record of what was stored/);
  assert.match(note, /not that it matches your copy/);
  assert.doesNotMatch(note, /Possession was proven/);
});

test("no provider answered: no claim at all, strong or not", () => {
  for (const strong of [true, false]) {
    assert.equal(trustNote({ strong, results: [] }), "");
    assert.equal(trustNote({ strong, results: [skipped, older] }), "");
  }
});

test("a failed proof still counts as an answered challenge", () => {
  // The independent check is what caught it, so the note still applies.
  assert.match(trustNote({ strong: true, results: [failed] }), /your own bytes/);
});

test("the old overclaim never appears, in any combination", () => {
  for (const strong of [true, false])
    for (const results of [[], [pass], [failed], [skipped], [pass, failed, skipped, older]])
      assert.doesNotMatch(trustNote({ strong, results }), /trusted nothing|trusts nothing/i);
});
