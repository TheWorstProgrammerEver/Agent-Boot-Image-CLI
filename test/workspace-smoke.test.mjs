import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const packages = [
  "assembly",
  "definition",
  "synth",
  "process",
  "os-linux",
  "runner",
  "cli",
];

test("every workspace package builds as an importable ES module", async () => {
  for (const packageName of packages) {
    const module = await import(`@agent-boot/${packageName}`);
    assert.ok(module);
  }
});

test("the on-image runner cannot be published", async () => {
  const manifestUrl = new URL("../packages/runner/package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.equal(manifest.private, true);
});
