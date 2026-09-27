// A damaged roots.json is never silently replaced, and never blocks storage.
//
// roots.json holds the merkle root of every upload, computed on this machine.
// It is what lets verify compare providers' answers against the user's own
// commitment instead of the coordinator's. Through 0.7.5 a file that failed to
// parse was read as empty and the next upload overwrote it with no signal, and
// a failed write was swallowed (bridge #9, second half).
//
// Adapted from Grok's test in obsideo-agent-bridge PR #13. His two checks are
// kept: the corrupt bytes survive, and the failure is visible. As agreed on the
// PR, "survive" accepts the file left in place OR moved aside intact to
// roots.json.corrupt-*, and "visible" is tightened from any stderr output to a
// message naming roots.json, which the PR listed as a known limit. Added: the
// warning also reaches the next tool result (an agent may never see stderr),
// the upload's own commitment is still recorded, and an unreadable file or a
// failed write is reported rather than swallowed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "obsideo-roots-"));
process.env.OBSIDEO_MCP_HOME = home;
const { recordRoot, lookupRoot, takeRootsNotice, CONFIG_DIR } = await import("../dist/config.js");
if (path.resolve(CONFIG_DIR) !== path.resolve(home)) throw new Error(`refusing to run: CONFIG_DIR is ${CONFIG_DIR}`);
const ROOTS = path.join(home, "roots.json");

const rec = { root: "abc", bytes: 3, encrypted: false, at: "2026-09-27T00:00:00Z" };

beforeEach(() => {
  for (const f of fs.readdirSync(home)) {
    const p = path.join(home, f);
    try { fs.chmodSync(p, 0o666); } catch {}
    fs.rmSync(p, { recursive: true, force: true });
  }
  takeRootsNotice();
});

/** Run fn with stderr captured; returns [result, stderr text, thrown error]. */
function capture(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return true; };
  let out, err = null;
  try { out = fn(); } catch (e) { err = e; } finally { process.stderr.write = orig; }
  return [out, chunks.join(""), err];
}

/** Every copy of `bytes` in the config dir: in place, or moved aside. */
function survivingCopies(bytes) {
  return fs.readdirSync(home)
    .filter((f) => f === "roots.json" || f.startsWith("roots.json.corrupt"))
    .filter((f) => fs.statSync(path.join(home, f)).isFile() && fs.readFileSync(path.join(home, f), "utf8") === bytes);
}

for (const [label, bytes] of [["unparseable", "{ this is not json\n"], ["valid JSON but not an object", "[1, 2, 3]\n"]]) {
  test(`${label}: the bytes survive, the failure is visible, and storage still records`, () => {
    fs.writeFileSync(ROOTS, bytes, "utf8");
    const [, stderr, threw] = capture(() => recordRoot("bkt", "obj", rec));
    assert.equal(threw, null, "a damaged roots.json must never block storage");
    assert.ok(survivingCopies(bytes).length >= 1, "the damaged file was replaced and its bytes lost");
    assert.match(stderr, /roots\.json/, "no warning naming roots.json on stderr");
    const notice = takeRootsNotice();
    assert.match(notice, /roots\.json/, "the next tool result would not mention it");
    assert.match(notice, /moved aside|left as it is/);
    assert.equal(takeRootsNotice(), "", "the notice is shown once");
    assert.deepEqual(lookupRoot("bkt", "obj"), rec, "the upload's own commitment was not recorded");
  });
}

test("a damaged file found by verify (lookup) is handled the same way", () => {
  const bytes = "{ truncated";
  fs.writeFileSync(ROOTS, bytes, "utf8");
  const [found, stderr, threw] = capture(() => lookupRoot("bkt", "obj"));
  assert.equal(threw, null);
  assert.equal(found, undefined);
  assert.ok(survivingCopies(bytes).length >= 1);
  assert.match(stderr, /roots\.json/);
  assert.match(takeRootsNotice(), /roots\.json/);
});

test("an unreadable roots.json is reported and left alone, and storage still succeeds", () => {
  fs.mkdirSync(ROOTS); // reading a directory fails on every platform
  const [, stderr, threw] = capture(() => recordRoot("bkt", "obj", rec));
  assert.equal(threw, null);
  assert.ok(fs.statSync(ROOTS).isDirectory(), "the unreadable path was replaced");
  assert.match(stderr, /could not read/);
  assert.match(takeRootsNotice(), /could not read/);
});

test("a failed write is reported, not swallowed, and the existing commitments are kept", () => {
  const good = JSON.stringify({ "bkt/old": rec }, null, 2) + "\n";
  fs.writeFileSync(ROOTS, good);
  fs.chmodSync(ROOTS, 0o444); // read-only: the write fails on Windows and POSIX (non-root)
  if (process.getuid?.() === 0) return; // root ignores the mode bits
  const [, stderr, threw] = capture(() => recordRoot("bkt", "new", rec));
  assert.equal(threw, null, "a failed commitment write must never fail the upload");
  assert.match(stderr, /could not be saved/);
  assert.match(takeRootsNotice(), /upload commitment for new could not be saved/);
  assert.equal(fs.readFileSync(ROOTS, "utf8"), good);
});

test("a healthy roots.json produces no notice", () => {
  const [, stderr] = capture(() => { recordRoot("bkt", "a", rec); recordRoot("bkt", "b", rec); });
  assert.equal(stderr, "");
  assert.equal(takeRootsNotice(), "");
  assert.deepEqual(lookupRoot("bkt", "b"), rec);
});
