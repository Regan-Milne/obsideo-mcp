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

test("strong check: rests on your bytes, and says what still came from the coordinator", () => {
  const note = trustNote({ strong: true, results: [pass] });
  assert.match(note, /your own bytes/);
  assert.match(note, /still came from the coordinator/);
  assert.match(note, /public keys/);
});

test("coordinator root: says so, and does not claim it shows they hold your bytes", () => {
  const note = trustNote({ strong: false, results: [pass] });
  assert.match(note, /coordinator's recorded root/);
  assert.match(note, /does not show they hold your bytes/);
  assert.doesNotMatch(note, /your own bytes/);
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
