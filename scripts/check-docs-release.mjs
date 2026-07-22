import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const visitorRoots = ["README.md", "docs", "examples"];

const collectFiles = async path => {
  const metadata = await stat(path);
  if (metadata.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry =>
    collectFiles(join(path, entry.name))));
  return nested.flat();
};

const visitorFiles = (await Promise.all(visitorRoots.map(path =>
  collectFiles(join(repositoryRoot, path))))).flat();
const markdownFiles = visitorFiles.filter(path => extname(path) === ".md");
const textFiles = visitorFiles.filter(path => [".md", ".sh", ".ts"].includes(extname(path)));

const contents = new Map(await Promise.all(textFiles.map(async path =>
  [path, await readFile(path, "utf8")])));

for (const markdownPath of markdownFiles) {
  const markdown = contents.get(markdownPath);
  assert.ok(markdown !== undefined);
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (target.startsWith("http://") || target.startsWith("https://") ||
        target.startsWith("mailto:") || target.startsWith("#")) continue;
    const localTarget = decodeURIComponent(target.split("#", 1)[0]);
    assert.notEqual(localTarget, "", `${relative(repositoryRoot, markdownPath)} has an empty link`);
    const resolved = resolve(dirname(markdownPath), localTarget);
    assert.ok(
      resolved.startsWith(`${repositoryRoot}/`),
      `${relative(repositoryRoot, markdownPath)} links outside the repository: ${target}`,
    );
    await stat(resolved).catch(() => {
      assert.fail(`${relative(repositoryRoot, markdownPath)} has a broken link: ${target}`);
    });
  }
}

const visitorText = [...contents.values()].join("\n");
const exampleText = [...contents]
  .filter(([path]) => relative(repositoryRoot, path).startsWith("examples/"))
  .map(([, value]) => value)
  .join("\n");

const forbiddenVisitorPatterns = [
  /\/home\/[A-Za-z0-9._-]+\//u,
  /scratchpad/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
];
for (const pattern of forbiddenVisitorPatterns) assert.doesNotMatch(visitorText, pattern);

for (const pattern of [
  /authoritative.{0,40}scratchpad/iu,
  /provenance\.json/iu,
  /TheWorstProgrammerEver/iu,
  /\b(?:daedalus|momus|maximus|mnemosyne)\b/iu,
]) assert.doesNotMatch(exampleText, pattern);

assert.doesNotMatch(
  visitorText,
  /\/dev\/disk\/by-id\/(?!\.\.\.|usb-example-target)[A-Za-z0-9._:+-]+/u,
);

const catalogSource = await readFile(
  join(repositoryRoot, "packages/os-adapters/src/catalog/raspberry-pi-os.ts"),
  "utf8",
);
const supportedMatrix = await readFile(join(repositoryRoot, "docs/supported-matrix.md"), "utf8");
for (const expected of [
  "raspberry-pi-os-lite-trixie-arm64",
  "raspberry-pi-os-lite-trixie-arm64-2026-06-18",
  "2026-06-18-raspios-trixie-arm64-lite.img.xz",
  "524875608",
  "acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3",
  "raspberry-pi-5",
]) {
  const sourceForm = expected === "524875608" ? "524_875_608" : expected;
  assert.match(catalogSource, new RegExp(sourceForm, "u"));
  assert.match(supportedMatrix, new RegExp(expected, "u"));
}

const cliReadme = await readFile(join(repositoryRoot, "packages/cli/README.md"), "utf8");
for (const flag of [
  "--definition",
  "--output",
  "--os-lock",
  "--runner-runtime",
  "--runner-entrypoint",
  "--runner-bundle",
  "--cache-directory",
  "--lock-directory",
  "--target",
  "--expect-model",
  "--expect-serial",
  "--expect-transport",
  "--max-size-bytes",
  "--dry-run",
]) assert.match(cliReadme, new RegExp(flag, "u"));

const traceability = await readFile(join(repositoryRoot, "docs/traceability.md"), "utf8");
const traceabilityRows = traceability.split("\n").filter(line =>
  line.startsWith("| ") && !line.startsWith("| ---") &&
  !line.startsWith("| Root definition"));
assert.equal(traceabilityRows.length, 17, "traceability must map all 17 root DoD items");
for (const required of ["RYA-193", "RYA-197", "PR #32", "PR #31", "RYA-146 physical evidence"]) {
  assert.match(traceability, new RegExp(required, "u"));
}

process.stdout.write(
  `Release docs verified: ${String(markdownFiles.length)} Markdown links/scans, ` +
  "CLI snippets, supported matrix, and 17 traceability rows.\n",
);
