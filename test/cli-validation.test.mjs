import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

import {
  VALIDATION_EXIT_CODE,
  loadTrustedDefinition,
  runCreateAgent,
} from "../packages/cli/dist/index.js";
import {
  createDefinitionFixture,
  makeSecretUnreadable,
  validDefinitionSource,
} from "../test-support/cli-definition-fixtures.mjs";

const run = async (definitionPath) => {
  const stdout = [];
  const stderr = [];
  const exitCode = await runCreateAgent(["validate", definitionPath], {
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  });
  return { exitCode, output: [...stdout, ...stderr].join("\n"), stderr, stdout };
};

test("trusted TypeScript definition loading and validation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-cli-test-"));
  try {
    await context.test("loads one default export and normalizes every reference", async () => {
      const fixture = await createDefinitionFixture(root, "valid");
      const seenUrls = [];
      const loaded = await loadTrustedDefinition(fixture.definitionPath, {
        inspectReferenceMetadata: async (url) => {
          seenUrls.push(url.href);
          return { isFile: true, isSymbolicLink: false };
        },
      });

      assert.equal(loaded.definition.agent.id, "my-agent");
      assert.equal(loaded.referenceCount, 4);
      assert.equal(seenUrls.length, 4);
      assert.ok(seenUrls.every((url) => url.startsWith(`file://${fixture.directory}/refs/`)));
    });

    await context.test("loads a default export created by the definition SDK", async () => {
      const sdkUrl = new URL("../packages/definition/dist/index.js", import.meta.url).href;
      const source = validDefinitionSource()
        .replace(
          "const definition: unknown =",
          `import { defineAgent } from ${JSON.stringify(sdkUrl)};\nconst definition =`,
        )
        .replace(
          "export default definition satisfies object;",
          "export default defineAgent(definition);",
        );
      const fixture = await createDefinitionFixture(root, "sdk-default-export", source);
      const loaded = await loadTrustedDefinition(fixture.definitionPath);

      assert.equal(loaded.definition.definitionUrl, new URL(
        `file://${fixture.definitionPath}`,
      ).href);
      assert.equal(loaded.referenceCount, 4);
    });

    await context.test("roots references at the definition regardless of cwd", async () => {
      const fixture = await createDefinitionFixture(root, "cwd-independent");
      const originalCwd = process.cwd();
      const otherCwd = await mkdtemp(join(root, "other-cwd-"));
      try {
        process.chdir(otherCwd);
        const loaded = await loadTrustedDefinition(fixture.definitionPath);
        assert.equal(
          loaded.definition.assets[0].source.url,
          `file://${fixture.directory}/refs/asset.json`,
        );
      } finally {
        process.chdir(originalCwd);
      }
    });

    await context.test("accepts metadata-only inspection of an unreadable secret", async () => {
      const fixture = await createDefinitionFixture(root, "unreadable-secret");
      await makeSecretUnreadable(fixture.secretPath);
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.valid);
      assert.match(result.output, /contents were not read/u);
      assert.doesNotMatch(result.output, /fixture-secret-must-not-appear/u);
    });

    await context.test("executable CLI returns the documented valid exit code", async () => {
      const fixture = await createDefinitionFixture(root, "executable-cli");
      const result = spawnSync(
        process.execPath,
        ["packages/cli/dist/bin.js", "validate", fixture.definitionPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, VALIDATION_EXIT_CODE.valid, result.stderr);
      assert.match(result.stdout, /Definition valid:/u);
      assert.match(result.stderr, /trusted executable code/u);
    });

    await context.test("rejects missing, additional, and wrong exports", async () => {
      const missing = await createDefinitionFixture(
        root,
        "missing-export",
        "export const agent = {};",
      );
      const additional = await createDefinitionFixture(
        root,
        "additional-export",
        `${validDefinitionSource()}\nexport const metadata = {};`,
      );
      const wrong = await createDefinitionFixture(
        root,
        "wrong-export",
        "export default () => 'not an agent';",
      );

      for (const fixture of [missing, additional]) {
        const result = await run(fixture.definitionPath);
        assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
        assert.match(result.output, /Export exactly one value/u);
      }
      const wrongResult = await run(wrong.definitionPath);
      assert.equal(wrongResult.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(wrongResult.output, /:\$: Expected an object/u);
    });

    await context.test("classifies multiple default exports as invalid syntax", async () => {
      const fixture = await createDefinitionFixture(
        root,
        "multiple-defaults",
        "export default {};\nexport default {};",
      );
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(result.output, /could not be parsed/u);
      assert.match(result.output, /multiple-defaults\/agent\.ts/u);
    });

    await context.test("reports schema paths while redacting invalid values", async () => {
      const source = validDefinitionSource().replace(
        'id: "my-agent"',
        'id: "sensitive-invalid-value!"',
      );
      const fixture = await createDefinitionFixture(root, "invalid-schema", source);
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(result.output, /:\$\.agent\.id:/u);
      assert.match(result.output, /lowercase identifier/u);
      assert.doesNotMatch(result.output, /sensitive-invalid-value/u);
    });

    await context.test("distinguishes incompatible protocol versions", async () => {
      const fixture = await createDefinitionFixture(
        root,
        "incompatible",
        validDefinitionSource({ schemaVersion: 2 }),
      );
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.incompatibleProtocol);
      assert.match(result.output, /Incompatible protocol/u);
      assert.doesNotMatch(result.output, /schemaVersion.*2/u);
    });

    await context.test("performs compatibility metadata schema checks", async () => {
      const source = validDefinitionSource().replace(
        'architecture: "arm64"',
        'architecture: "ARM 64"',
      );
      const fixture = await createDefinitionFixture(root, "bad-compatibility", source);
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(result.output, /operatingSystem\.compatibility\.architecture/u);
    });

    await context.test("reports missing reference metadata as invalid", async () => {
      const fixture = await createDefinitionFixture(
        root,
        "bad-reference",
        validDefinitionSource({ assetSource: "./refs/missing.json" }),
      );
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(result.output, /:\$\.assets\[0\]\.source\.url:/u);
      assert.match(result.output, /does not exist/u);
      assert.doesNotMatch(result.output, /missing\.json/u);
    });

    await context.test("rejects a definition URL unrelated to its source file", async () => {
      const fixture = await createDefinitionFixture(
        root,
        "wrong-definition-url",
        validDefinitionSource({ definitionUrl: '"file:///caller/agent.ts"' }),
      );
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.invalidDefinition);
      assert.match(result.output, /:\$\.definitionUrl:/u);
      assert.match(result.output, /Use import\.meta\.url/u);
    });

    await context.test("redacts thrown module errors and reports their source line", async () => {
      const fixture = await createDefinitionFixture(
        root,
        "thrown-module",
        'throw new Error("fixture-secret-must-not-appear");',
      );
      const result = await run(fixture.definitionPath);

      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.operationalLoaderFailure);
      assert.match(result.output, /Loader failure:/u);
      assert.match(result.output, /agent\.ts:1:/u);
      assert.doesNotMatch(result.output, /fixture-secret-must-not-appear/u);
    });

    await context.test("does not execute definition commands or import adapters", async () => {
      const fixture = await createDefinitionFixture(root, "no-command-execution");
      const sentinel = join(fixture.directory, "command-was-executed");
      await writeFile(
        join(fixture.directory, "refs", "prepare.sh"),
        `touch ${JSON.stringify(sentinel)}`,
        "utf8",
      );

      const result = await run(fixture.definitionPath);
      assert.equal(result.exitCode, VALIDATION_EXIT_CODE.valid);
      await assert.rejects(access(sentinel));

      const loaderSource = await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../packages/cli/src/trusted-definition-loader.ts",
        ),
        "utf8",
      );
      assert.doesNotMatch(
        loaderSource,
        /@agent-boot\/(?:os-linux|process|runner|synth)|node:child_process/u,
      );
    });

    await context.test("uses a distinct usage exit code", async () => {
      const stdout = [];
      const stderr = [];
      const exitCode = await runCreateAgent([], {
        stdout: (line) => { stdout.push(line); },
        stderr: (line) => { stderr.push(line); },
      });
      assert.equal(exitCode, VALIDATION_EXIT_CODE.usage);
      assert.deepEqual(stdout, []);
      assert.match(stderr.join("\n"), /Usage:/u);
    });

    assert.equal(relative(tmpdir(), root).startsWith("agent-boot-cli-test-"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
