import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { URL, pathToFileURL } from "node:url";

import {
  AssemblyRecoveryError,
  canonicalJson,
  writeAssemblyAtomically,
} from "../packages/assembly/dist/index.js";
import { agentDefinitionSchema } from "../packages/definition/dist/index.js";
import {
  assemblyDocumentsSchema,
  osLockSchema,
} from "../packages/protocol/dist/index.js";
import {
  SynthesisError,
  synthesizeAssembly,
} from "../packages/synth/dist/index.js";

const osLockFixtureUrl = new URL(
  "../packages/protocol/fixtures/assembly/os-lock.json",
  import.meta.url,
);

const setupDefinition = async (root) => {
  const sourceRoot = join(root, "definition");
  await mkdir(join(sourceRoot, "files"), { recursive: true });
  const paths = {
    asset: join(sourceRoot, "files", "config.json"),
    definition: join(sourceRoot, "agent.ts"),
    prompt: join(sourceRoot, "files", "bootstrap.md"),
    script: join(sourceRoot, "files", "prepare.sh"),
    secret: join(sourceRoot, "files", "credential"),
  };
  await Promise.all([
    writeFile(paths.asset, "{\"enabled\":true}\n", "utf8"),
    writeFile(paths.definition, "export default {};\n", "utf8"),
    writeFile(paths.prompt, "Hello {{agent-name}}\n", "utf8"),
    writeFile(paths.script, "#!/bin/sh\nexit 0\n", "utf8"),
    writeFile(paths.secret, "secret-read-sentinel", { encoding: "utf8", mode: 0o600 }),
  ]);
  const local = (kind, id, path) => ({
    kind,
    id,
    source: { kind: "local", url: pathToFileURL(path).href },
  });
  const definition = agentDefinitionSchema.parse({
    schemaVersion: 1,
    definitionUrl: pathToFileURL(paths.definition).href,
    agent: { id: "my-agent", displayName: "My Agent" },
    operatingSystem: {
      catalogId: "raspberry-pi-os-lite-trixie-arm64",
      compatibility: { architecture: "arm64", boards: ["raspberry-pi-5"] },
    },
    account: { username: "my-user", initialPassword: { secretId: "credential" } },
    assets: [{
      ...local("asset", "agent-config", paths.asset),
      placement: { scope: "user-home", path: ".config/agent/config.json" },
    }],
    prompts: [{
      ...local("prompt", "bootstrap", paths.prompt),
      variables: ["agent-name"],
    }],
    scripts: [local("script", "prepare", paths.script)],
    secrets: [local("secret", "credential", paths.secret)],
    providers: [],
    steps: [
      {
        id: "prepare",
        kind: "automatic",
        command: { executable: { scriptId: "prepare" }, arguments: [] },
      },
      {
        id: "render",
        kind: "prompt",
        templateId: "bootstrap",
        renderedPromptId: "rendered-bootstrap",
        retention: "ephemeral",
        variables: [{
          name: "agent-name",
          source: { kind: "secret", secretId: "credential" },
        }],
      },
    ],
  });
  return { definition, paths, sourceRoot };
};

const loadOsLock = async () =>
  osLockSchema.parse(JSON.parse(await readFile(osLockFixtureUrl, "utf8")));

const runnerArtifacts = {
  runtime: Buffer.from("runner-runtime\n", "utf8"),
  entrypoint: Buffer.from("export {};\n", "utf8"),
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const hashAssembly = (assembly) => {
  const hash = createHash("sha256");
  for (const file of assembly.files) {
    hash.update(file.path);
    hash.update(String(file.mode));
    hash.update(file.contents);
  }
  return hash.digest("hex");
};

test("deterministic redacted assembly synthesis", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-synth-test-"));
  try {
    const fixture = await setupDefinition(root);
    const osLock = await loadOsLock();

    await context.test("matches the golden documents and copied file bytes", async () => {
      const assembly = await synthesizeAssembly(fixture.definition, { osLock, runnerArtifacts });
      const goldenRoot = new URL("../packages/synth/fixtures/assembly/", import.meta.url);
      for (const document of ["manifest.json", "runner-plan.json", "os-lock.json"]) {
        const actual = assembly.files.find((file) => file.path === document);
        assert.ok(actual);
        assert.equal(Buffer.from(actual.contents).toString("utf8"), await readFile(
          new URL(document, goldenRoot),
          "utf8",
        ));
      }
      assert.equal(
        Buffer.from(assembly.files.find((file) => file.path === "assets/resources/agent-config").contents)
          .toString("utf8"),
        "{\"enabled\":true}\n",
      );
      assert.equal(
        Buffer.from(assembly.files.find((file) => file.path === "assets/scripts/prepare").contents)
          .toString("utf8"),
        "#!/bin/sh\nexit 0\n",
      );
      assert.equal(
        Buffer.from(assembly.files.find((file) => file.path === "prompts/bootstrap").contents)
          .toString("utf8"),
        "Hello {{agent-name}}\n",
      );
      assert.deepEqual(assemblyDocumentsSchema.parse(assembly.documents), assembly.documents);
    });

    await context.test("produces the same identifier and repeat hash", async () => {
      const first = await synthesizeAssembly(fixture.definition, { osLock, runnerArtifacts });
      const second = await synthesizeAssembly(fixture.definition, { osLock, runnerArtifacts });
      assert.equal(first.assemblyId, second.assemblyId);
      assert.equal(hashAssembly(first), hashAssembly(second));
      assert.deepEqual(first.files, second.files);
    });

    await context.test("never reads secret contents", async () => {
      const reads = [];
      const access = {
        inspect: async () => {},
        read: async (path) => {
          reads.push(path);
          return readFile(path);
        },
      };
      const assembly = await synthesizeAssembly(fixture.definition, {
        osLock,
        runnerArtifacts,
        sourceFileAccess: access,
      });
      assert.equal(reads.includes(fixture.paths.secret), false);
      const serialized = assembly.files.map((file) => Buffer.from(file.contents).toString("utf8")).join("\n");
      assert.doesNotMatch(serialized, /secret-read-sentinel/u);
      assert.match(canonicalJson(assembly.documents), /"secretId": "credential"/u);
    });

    await context.test("keeps generated asset identifiers within protocol limits", async () => {
      const longId = `s${"a".repeat(63)}`;
      const definition = clone(fixture.definition);
      definition.scripts[0].id = longId;
      definition.steps[0].command.executable.scriptId = longId;
      const assembly = await synthesizeAssembly(definition, { osLock, runnerArtifacts });
      const scriptAsset = assembly.documents.manifest.assets.find((asset) =>
        asset.path.startsWith("assets/scripts/"));
      assert.ok(scriptAsset);
      assert.ok(scriptAsset.id.length <= 64);

      const reserved = clone(fixture.definition);
      reserved.assets[0].id = "runner-runtime";
      await assert.rejects(
        synthesizeAssembly(reserved, { osLock, runnerArtifacts }),
        (error) => error instanceof SynthesisError && error.kind === "invalid-input",
      );
    });

    await context.test("rejects traversal, symlinks, and unsupported file types", async () => {
      const outsidePath = join(root, "outside.txt");
      await writeFile(outsidePath, "outside", "utf8");
      const traversing = clone(fixture.definition);
      traversing.assets[0].source.url = pathToFileURL(outsidePath).href;
      await assert.rejects(
        synthesizeAssembly(traversing, { osLock, runnerArtifacts }),
        (error) => error instanceof SynthesisError && error.kind === "unsafe-reference",
      );

      const symlinkPath = join(fixture.sourceRoot, "files", "linked-config");
      await symlink(fixture.paths.asset, symlinkPath);
      const linked = clone(fixture.definition);
      linked.assets[0].source.url = pathToFileURL(symlinkPath).href;
      await assert.rejects(
        synthesizeAssembly(linked, { osLock, runnerArtifacts }),
        (error) => error instanceof SynthesisError && error.kind === "unsafe-reference",
      );

      const directory = clone(fixture.definition);
      directory.assets[0].source.url = pathToFileURL(join(fixture.sourceRoot, "files")).href;
      await assert.rejects(
        synthesizeAssembly(directory, { osLock, runnerArtifacts }),
        (error) => error instanceof SynthesisError && error.kind === "unsafe-reference",
      );
    });

    await context.test("publishes atomically, rolls replacement back, and cleans temporary state", async () => {
      const assembly = await synthesizeAssembly(fixture.definition, { osLock, runnerArtifacts });
      const output = join(root, "assembly-output");
      await assert.rejects(
        writeAssemblyAtomically(output, assembly.files, {
          hooks: { beforeCommit: () => { throw new Error("injected failure"); } },
        }),
      );
      await assert.rejects(readFile(join(output, "manifest.json")));
      assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-")), []);

      await mkdir(output);
      await Promise.all([
        writeFile(join(output, "preserved.txt"), "preserved", "utf8"),
        writeFile(join(output, "manifest.json"), "old manifest", "utf8"),
        writeFile(join(output, "runner-plan.json"), "old plan", "utf8"),
        writeFile(join(output, "os-lock.json"), "old lock", "utf8"),
      ]);
      await assert.rejects(writeAssemblyAtomically(output, assembly.files));
      await assert.rejects(
        writeAssemblyAtomically(output, assembly.files, {
          replace: true,
          hooks: { afterExistingMoved: () => { throw new Error("injected failure"); } },
        }),
      );
      assert.equal(await readFile(join(output, "preserved.txt"), "utf8"), "preserved");
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes(".staging-") || name.includes(".backup-")),
        [],
      );

      await writeAssemblyAtomically(output, assembly.files, { replace: true });
      assert.equal(await readFile(join(output, "manifest.json"), "utf8"), canonicalJson(assembly.documents.manifest));
    });

    await context.test("preserves the prior assembly when replacement rollback fails", async () => {
      const assembly = await synthesizeAssembly(fixture.definition, { osLock, runnerArtifacts });
      const output = join(root, "rollback-failure-output");
      await mkdir(output);
      await Promise.all([
        writeFile(join(output, "preserved.txt"), "preserved", "utf8"),
        writeFile(join(output, "manifest.json"), "old manifest", "utf8"),
        writeFile(join(output, "runner-plan.json"), "old plan", "utf8"),
        writeFile(join(output, "os-lock.json"), "old lock", "utf8"),
      ]);

      let recoveryPath;
      await assert.rejects(
        writeAssemblyAtomically(output, assembly.files, {
          replace: true,
          hooks: {
            afterExistingMoved: async () => {
              await mkdir(output);
              await writeFile(join(output, "interloper.txt"), "interloper", "utf8");
              throw new Error("injected replacement failure");
            },
          },
        }),
        (error) => {
          assert.ok(error instanceof AssemblyRecoveryError);
          recoveryPath = error.recoveryPath;
          return true;
        },
      );

      assert.equal(await readFile(join(output, "interloper.txt"), "utf8"), "interloper");
      assert.equal(await readFile(join(recoveryPath, "preserved.txt"), "utf8"), "preserved");
      assert.match(recoveryPath, /\.rollback-failure-output\.backup-/u);
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes(".staging-")),
        [],
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.includes(".backup-")),
        [basename(recoveryPath)],
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
