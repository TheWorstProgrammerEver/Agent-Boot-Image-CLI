import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const packages = [
  "protocol",
  "assembly",
  "definition",
  "synth",
  "process",
  "os-adapters",
  "os-linux",
  "runner",
  "runner-bundle",
  "cli",
];

test("every workspace package builds as an importable ES module", async () => {
  for (const packageName of packages) {
    const module = await import(`@agent-boot/${packageName}`);
    assert.ok(module);
  }
});

test("the on-image runner and its bundle cannot be published", async () => {
  for (const packageName of ["runner", "runner-bundle"]) {
    const manifestUrl = new URL(`../packages/${packageName}/package.json`, import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    assert.equal(manifest.private, true);
  }
});
