// What a verify result claims.
//
// Guarded because it is the text an agent reads to decide how far to trust the
// check. Two releases got it wrong in turn:
//   through 0.7.3  "trusted nothing the coordinator asserted" on every result
//   0.7.4          "Possession was proven on this machine" after a failed-only
//                  result, directly under the integrity alarm; unsigned passes
//                  described as signature-checked; "Verified ... they hold your
//                  exact bytes" printed at 0 of N
//   0.7.5          partial success rounded up: a pass plus a failed proof got
//                  the affirmative paragraph straight under the ALARM, and a
//                  1-of-3 fallback said "the providers hold" as if all passed
// Found by an outside agent review. Each case below is one of those states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { trustNote, formatVerifyResult } = await import("../dist/verify.js");

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

test("the result text never asserts a verdict, and unsigned passes are labelled as unsigned", () => {
  const src = readFileSync(new URL("../dist/verify.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /they hold your exact bytes/);
  assert.doesNotMatch(src, /Verified against the/);
  const out = formatVerifyResult(result({ rootSource: "recorded", passes: [false] }));
  assert.match(out, /proved, unsigned \(no public key listed for this provider\)/);
});

test("index.js formats verify through formatVerifyResult, not its own copy", () => {
  const src = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.match(src, /formatVerifyResult\(r\)/);
  assert.doesNotMatch(src, /providers proved possession of/);
});

// ---- 0.7.6: partial success, as the agent reads the whole result ----------

// A result built the way verifyObject builds one. passes: one entry per passing
// provider (true = signed); failed: providers that answered and failed the
// proof; older: providers that could not be challenged.
function result({ rootSource, passes = [true], failed = 0, older = 0, encryptedObject = false }) {
  const results = [];
  passes.forEach((signed, i) =>
    results.push({ provider_id: `p${i}`, address: `https://p${i}.example`, pass: true, signed, ms: 10 }));
  for (let i = 0; i < failed; i++)
    results.push({ provider_id: `f${i}`, address: `https://f${i}.example`, pass: false, signed: false, ms: 10,
      failed_proof: true, error: "answered but failed integrity/signature check" });
  for (let i = 0; i < older; i++)
    results.push({ provider_id: `o${i}`, address: `https://o${i}.example`, pass: false, signed: false, ms: 10,
      older_node: true, error: "older node: no client-challenge endpoint" });
  return {
    bucket: "b", key: "k", root: "00", strong: rootSource !== "coordinator", rootSource,
    encryptedObject: encryptedObject || undefined,
    holders: results.length,
    proved: passes.length,
    signed: passes.filter(Boolean).length,
    failed,
    mismatch: failed > 0,
    results,
  };
}
const MODES = ["local-file", "recorded", "coordinator"];
// The note is the last paragraph of the result.
const noteOf = (out) => out.slice(out.lastIndexOf("\n\n") + 2);

test("pass + failed proof: the note names the failure first, then scopes to the passing providers (strong and fallback)", () => {
  for (const rootSource of MODES) {
    const out = formatVerifyResult(result({ rootSource, passes: [true, true], failed: 1 }));
    assert.match(out, /ALARM/);
    assert.match(out, /WARNING: a provider answered but failed the proof/);
    const note = noteOf(out);
    assert.match(note, /^This is not a clean result: 1 of 3 providers answered but failed the proof/, rootSource);
    assert.match(note, /covers only the 2 that passed/, rootSource);
    // the failure is stated before anything affirmative
    assert.ok(note.indexOf("failed the proof") < note.indexOf("The comparison ran"), rootSource);
  }
});

test("proved < holders, no failure: the note says it is silent on the unchallenged providers (strong and fallback)", () => {
  for (const rootSource of MODES) {
    const out = formatVerifyResult(result({ rootSource, passes: [true], older: 2 }));
    assert.match(out, /^1 of 3 providers proved possession/);
    const note = noteOf(out);
    assert.match(note, /2 of 3 could not be challenged this time/, rootSource);
    assert.match(note, /says nothing about them/, rootSource);
    assert.doesNotMatch(note, /not a clean result/, rootSource);
  }
});

test("fallback never says 'the providers hold': each passing answer speaks only for its responder", () => {
  for (const [passes, failed, older] of [[[true], 0, 2], [[true, true], 1, 0], [[true, true, true], 0, 0]]) {
    const out = formatVerifyResult(result({ rootSource: "coordinator", passes, failed, older }));
    assert.doesNotMatch(out, /the providers hold/i);
    assert.match(out, /Each passing answer shows that its responder holds data matching the coordinator-supplied root/);
  }
});

test("the headline says what was sampled: one randomly chosen chunk per provider", () => {
  for (const rootSource of MODES)
    assert.match(formatVerifyResult(result({ rootSource })), /^1 of 1 providers proved possession of k right now \(one randomly chosen chunk per provider\)/);
});

test("says, visibly, that the tokens came from the coordinator and the chunks and paths from providers it named", () => {
  for (const rootSource of MODES)
    assert.match(formatVerifyResult(result({ rootSource })),
      /issued the challenge tokens; the chunks and merkle paths came from the providers it named/);
});

test("a clean full pass carries no failure or silence caveat", () => {
  for (const rootSource of MODES) {
    const note = noteOf(formatVerifyResult(result({ rootSource, passes: [true, true, true] })));
    assert.doesNotMatch(note, /not a clean result|could not be challenged/);
  }
});

test("failed only (nothing passed): still no note at all, in every mode", () => {
  for (const rootSource of MODES) {
    const out = formatVerifyResult(result({ rootSource, passes: [], failed: 1, older: 1 }));
    assert.match(out, /WARNING/);
    assert.doesNotMatch(out, /The comparison ran|not a clean result/);
  }
});
