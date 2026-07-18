import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPackageBoundaries } from "../scripts/check-package-boundaries.mjs";

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);

test("the boundary checker rejects a provider package importing an OS package", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-boundary-"));

  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "packages/assembly/src"), { recursive: true });
    await mkdir(join(root, "packages/os-linux/src"), { recursive: true });
    await writeJson(join(root, "config/package-boundaries.json"), {
      packagePrefix: "@agent-boot/",
      packages: { assembly: [], "os-linux": [] },
    });
    await writeJson(join(root, "packages/assembly/package.json"), {
      name: "@agent-boot/assembly",
    });
    await writeJson(join(root, "packages/os-linux/package.json"), {
      name: "@agent-boot/os-linux",
    });
    await writeFile(
      join(root, "packages/assembly/src/index.ts"),
      'export type Illegal = import("@agent-boot/os-linux").Illegal;\n',
    );
    await writeFile(join(root, "packages/os-linux/src/index.ts"), "export {};\n");

    await assert.rejects(
      checkPackageBoundaries({ root }),
      /imports disallowed workspace package @agent-boot\/os-linux/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
