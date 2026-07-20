import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

test("CI stays inside an unprivileged, non-device container", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const prohibited = [
    /--privileged/iu,
    /\/dev\//u,
    /\bsudo\b/iu,
    /\b(?:blkid|fdisk|losetup|lsblk|mount|parted|umount)\b/iu,
    /\bdd\s+\b(?:if|of)=/iu,
  ];

  assert.match(workflow, /image: node:24-bookworm/u);
  assert.match(workflow, /--user 1001:122/u);
  assert.match(workflow, /--cap-drop=ALL/u);
  assert.match(workflow, /--security-opt=no-new-privileges/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /non-destructive-integration:/u);
  assert.match(workflow, /npm run test:non-destructive/u);
  assert.match(workflow, /if: failure\(\)/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /\.artifacts\/non-destructive/u);

  for (const pattern of prohibited) {
    assert.doesNotMatch(workflow, pattern);
  }
});
