// backup_keys has no default destination.
//
// Through 0.7.5 a call with no destination wrote an archive holding the
// encryption key to a predictable path in the home directory, a place nobody
// chose. It now refuses and writes nothing (conceded on bridge #4). The tool
// description says so, and the two are tested together here so the description
// can never ship ahead of the behaviour it describes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "obsideo-backup-"));
process.env.OBSIDEO_MCP_HOME = home;
fs.writeFileSync(path.join(home, "mcp.json"),
  JSON.stringify({ account_id: "acct-t", account_token: "tok", encryption_key: "k" }) + "\n");
fs.writeFileSync(path.join(home, "signing.pem"), "pem\n");
const { backupKeys } = await import("../dist/backup.js");

const listing = () => fs.readdirSync(home).sort();

for (const destination of [undefined, "", "   "]) {
  test(`no destination (${JSON.stringify(destination)}): refuses, writes nothing, and says why`, () => {
    const before = listing();
    assert.throws(() => backupKeys(destination), (e) => {
      assert.match(e.message, /needs a destination and has no default, so nothing was written/);
      assert.match(e.message, /Obsideo has no copy/);
      assert.match(e.message, /already authorized to use, or one your human names/);
      return true;
    });
    assert.deepEqual(listing(), before);
  });
}

test("a named .tar.gz destination is written", () => {
  const out = path.join(home, "dest", "keys.tar.gz");
  const msg = backupKeys(out);
  assert.ok(fs.statSync(out).size > 0);
  assert.match(msg, /Backed up 2 files/);
});

test("a named directory destination gets plain copies", () => {
  const out = path.join(home, "dest-dir");
  backupKeys(out);
  assert.deepEqual(fs.readdirSync(out).sort(), ["mcp.json", "signing.pem"]);
});

test("the tool description states the refusal, and no default path survives anywhere", () => {
  const index = fs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  const backup = fs.readFileSync(new URL("../dist/backup.js", import.meta.url), "utf8");
  assert.match(index, /With no destination it refuses/);
  assert.doesNotMatch(index + backup, /obsideo-keys-/);
  assert.doesNotMatch(index, /no path produces an archive/);
});
