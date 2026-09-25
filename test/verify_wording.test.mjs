// What a verify result claims.
//
// Guarded because it is the text an agent reads to decide how far to trust the
// check. Two releases got it wrong in turn:
//   through 0.7.3  "trusted nothing the coordinator asserted" on every result
//   0.7.4          "Possession was proven on this machine" after a failed-only
//                  result, directly under the integrity alarm; unsigned passes
//                  described as signature-checked; "Verified ... they hold your
//                  exact bytes" printed at 0 of N
// Found by an outside agent review. Each case below is one of those states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { trustNote } = await import("../dist/verify.js");

const note = (o) => trustNote({ rootSource: "recorded", encryptedObject: false, proved: 1, signed: 1, ...o });

test("nothing passed: no claim at all, whatever the root source", () => {
  // Covers both "nobody answered" and "only failed proofs": in both, proved is 0.
  for (const rootSource of ["local-file", "recorded", "coordinator"])
    for (const signed of [0])
      assert.equal(trustNote({ rootSource, encryptedObject: false, proved: 0, signed }), "");
});

test("recorded root: says where the root came from and that it does not rest on the coordinator's word", () => {
  const n = note({ rootSource: "recorded" });
  assert.match(n, /recorded when it uploaded the object/);
  assert.match(n, /does not depend on the coordinator's word about what was stored/);
  assert.doesNotMatch(n, /encrypted/);
});

test("recorded root for an encrypted object: says the root is of the ciphertext", () => {
  assert.match(note({ rootSource: "recorded", encryptedObject: true }), /root of the encrypted bytes/);
});

test("local file: says the root was computed just now from that file", () => {
  assert.match(note({ rootSource: "local-file" }), /computed just now from the file you passed/);
});

test("coordinator root: says so, and does not claim it matches your copy", () => {
  const n = note({ rootSource: "coordinator" });
  assert.match(n, /coordinator's record of what was stored/);
  assert.match(n, /not that it matches your copy/);
  assert.doesNotMatch(n, /does not depend on the coordinator's word/);
});

test("all passes signed: attribution relies on the coordinator's key listing, and says so", () => {
  const n = note({ proved: 2, signed: 2 });
  assert.match(n, /Every passing answer was signed/);
  assert.match(n, /public key as listed by the coordinator/);
});

test("unsigned pass: never described as signature-checked", () => {
  const n = note({ proved: 1, signed: 0 });
  assert.match(n, /None of the passing answers were signed/);
  assert.match(n, /does not show which provider answered/);
  assert.doesNotMatch(n, /Every passing answer was signed/);
});

test("mixed signed and unsigned: gives the counts", () => {
  const n = note({ proved: 3, signed: 1 });
  assert.match(n, /1 of 3 passing answers were signed/);
  assert.doesNotMatch(n, /Every passing answer was signed/);
});

test("always says what the coordinator still chose, whenever it says anything", () => {
  for (const rootSource of ["local-file", "recorded", "coordinator"])
    assert.match(note({ rootSource }), /coordinator also chose which providers to ask and where to reach them/);
});

test("none of the retired overclaims appear, in any state", () => {
  const retired = /trusted nothing|trusts nothing|Possession was proven|No Obsideo server takes part/i;
  for (const rootSource of ["local-file", "recorded", "coordinator"])
    for (const encryptedObject of [false, true])
      for (const [proved, signed] of [[0, 0], [1, 0], [1, 1], [3, 1], [3, 3]])
        assert.doesNotMatch(trustNote({ rootSource, encryptedObject, proved, signed }), retired);
});

test("the result header never asserts a verdict, and unsigned passes are labelled as unsigned", () => {
  // index.js is the server entry point and cannot be imported without starting
  // it, so these two are checked against the built text.
  const src = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /they hold your exact bytes/);
  assert.doesNotMatch(src, /Verified against the/);
  assert.match(src, /proved, unsigned \(no public key listed for this provider\)/);
});
