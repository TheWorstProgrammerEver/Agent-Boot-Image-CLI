import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const recipeRoot = join(repositoryRoot, "recipes", "github-app-helpers");
const jwtSentinel = "EXAMPLE_JWT_SENTINEL";
const tokenSentinel = "EXAMPLE_INSTALLATION_TOKEN_SENTINEL";
const parentTokenSentinel = "EXAMPLE_PARENT_TOKEN_SENTINEL";

const writeExecutable = async (path, contents) => {
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
};

const absent = path => assert.rejects(
  access(path, constants.F_OK),
  error => error.code === "ENOENT",
);

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-boot-github-helper-"));
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  const config = join(root, "config");
  const runtime = join(root, "runtime");
  const home = join(root, "home");
  await Promise.all([
    mkdir(bin),
    mkdir(capture),
    mkdir(config),
    mkdir(runtime, { mode: 0o700 }),
    mkdir(home),
  ]);
  await Promise.all([
    writeFile(join(config, "app.pem"), "EXAMPLE_PRIVATE_KEY_FIXTURE\n", { mode: 0o600 }),
    writeFile(join(config, "codex.env"), [
      "GITHUB_APP_ID=example-app-id",
      "GITHUB_INSTALLATION_ID=123456",
      "",
    ].join("\n"), { mode: 0o600 }),
    writeExecutable(join(bin, "openssl"), `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  base64)
    input="$(cat)"
    case "$input" in
      *'"typ":"JWT"'*) printf 'header' ;;
      *'"iat":'*) printf 'payload' ;;
      *) printf '%s' "$input" ;;
    esac
    ;;
  dgst)
    cat >/dev/null
    printf '${jwtSentinel}'
    ;;
  *) exit 2 ;;
esac
`),
    writeExecutable(join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
tr '\\0' '\\n' </proc/$$/cmdline >"$CAPTURE_DIRECTORY/curl.argv"
env >"$CAPTURE_DIRECTORY/curl.env"
cat >"$CAPTURE_DIRECTORY/curl.stdin"
if [[ "\${FAKE_CURL_MODE:-success}" == "failure" ]]; then
  printf '{"message":"${jwtSentinel} ${tokenSentinel}"}'
  printf 'curl failure: ${jwtSentinel} ${tokenSentinel}\n' >&2
  exit 22
fi
grep -F 'header = "Authorization: Bearer header.payload.${jwtSentinel}"' \
  "$CAPTURE_DIRECTORY/curl.stdin" >/dev/null
printf '{"token":"${tokenSentinel}","expires_at":"2030-01-02T03:04:05Z"}'
`),
  ]);

  const environment = {
    CAPTURE_DIRECTORY: capture,
    CODEX_GITHUB_CONFIG_DIR: config,
    FAKE_CURL_MODE: "success",
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: runtime,
  };
  return {
    bin,
    capture,
    cleanup: () => rm(root, { force: true, recursive: true }),
    environment,
    root,
    runtime,
  };
};

test("installer refreshes every managed helper byte-for-byte", async () => {
  const fixture = await createFixture();
  const helpers = ["codex-github-token", "codex-github-askpass", "codex-gh"];
  try {
    for (const helper of helpers) {
      await writeExecutable(join(fixture.bin, helper), "#!/usr/bin/env bash\nexit 99\n");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await execFileAsync(
        join(recipeRoot, "install-github-app-helpers.sh"),
        [],
        {
          encoding: "utf8",
          env: {
            CODEX_GITHUB_HELPER_INSTALL_DIR: fixture.bin,
            HOME: fixture.environment.HOME,
            PATH: fixture.environment.PATH,
          },
        },
      );
      for (const helper of helpers) {
        assert.deepEqual(
          await readFile(join(fixture.bin, helper)),
          await readFile(join(recipeRoot, helper)),
        );
        assert.equal((await stat(join(fixture.bin, helper))).mode & 0o777, 0o755);
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

test("askpass preserves repository and permission narrowing", async () => {
  const fixture = await createFixture();
  const permissions = '{"contents":"write","workflows":"write"}';
  try {
    await writeExecutable(join(fixture.bin, "codex-github-token"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$CAPTURE_DIRECTORY/askpass.arguments"
printf '${tokenSentinel}\n'
`);
    const result = await execFileAsync(
      join(recipeRoot, "codex-github-askpass"),
      ["Password for GitHub"],
      {
        encoding: "utf8",
        env: {
          ...fixture.environment,
          CODEX_GH_PERMISSIONS_JSON: permissions,
          CODEX_GH_REPO: "example-org/example-repo",
        },
      },
    );
    assert.equal(result.stdout, `${tokenSentinel}\n`);
    assert.equal(
      await readFile(join(fixture.capture, "askpass.arguments"), "utf8"),
      [
        "--permissions-json",
        permissions,
        "--repo",
        "example-org/example-repo",
        "",
      ].join("\n"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("post-cognition setup sources helpers from the maintained Agent Boot recipe", async () => {
  const definition = await readFile(
    join(repositoryRoot, "examples", "post-cognition-agent", "definition.ts"),
    "utf8",
  );
  const installer = await readFile(
    join(
      repositoryRoot,
      "examples",
      "post-cognition-agent",
      "scripts",
      "install-github-app-helpers.sh",
    ),
    "utf8",
  );
  assert.match(definition, /AGENT_BOOT_REPOSITORY/u);
  assert.match(definition, /workspace\/agent-boot-image-cli/u);
  assert.match(installer, /recipes\/github-app-helpers\/install-github-app-helpers\.sh/u);
  const retiredSourceNames = [
    ["Codex-Agent", "Setup"].join("-"),
    ["codex-agent", "setup"].join("-"),
  ];
  for (const name of retiredSourceNames) {
    assert.equal(`${definition}\n${installer}`.includes(name), false);
  }
});

test("token request keeps the JWT out of curl argv, environment, and failures", async () => {
  const fixture = await createFixture();
  const helper = join(recipeRoot, "codex-github-token");
  try {
    const success = await execFileAsync(
      "bash",
      [
        "-x",
        helper,
        "--permissions-json",
        '{"contents":"read","pull_requests":"write"}',
        "--repo",
        "example-org/example-repo",
        "--expires-at",
      ],
      { encoding: "utf8", env: fixture.environment },
    );
    assert.equal(success.stdout, "2030-01-02T03:04:05Z\n");
    assert.doesNotMatch(success.stderr, new RegExp(`${jwtSentinel}|${tokenSentinel}`, "u"));

    const argv = await readFile(join(fixture.capture, "curl.argv"), "utf8");
    const environment = await readFile(join(fixture.capture, "curl.env"), "utf8");
    const standardInput = await readFile(join(fixture.capture, "curl.stdin"), "utf8");
    assert.match(argv, /--config\n-\n/u);
    assert.match(
      argv,
      /--data\n\{"permissions":\{"contents":"read","pull_requests":"write"\},"repositories":\["example-repo"\]\}\n/u,
    );
    assert.doesNotMatch(argv, new RegExp(`${jwtSentinel}|${tokenSentinel}`, "u"));
    assert.doesNotMatch(environment, new RegExp(`${jwtSentinel}|${tokenSentinel}`, "u"));
    assert.match(
      standardInput,
      new RegExp(`Authorization: Bearer header\\.payload\\.${jwtSentinel}`, "u"),
    );

    await assert.rejects(
      execFileAsync("bash", ["-x", helper, "--expires-at"], {
        encoding: "utf8",
        env: { ...fixture.environment, FAKE_CURL_MODE: "failure" },
      }),
      error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /GitHub App token request failed\./u);
        assert.doesNotMatch(
          `${error.stdout}${error.stderr}`,
          new RegExp(`${jwtSentinel}|${tokenSentinel}`, "u"),
        );
        return true;
      },
    );

    const tokenOutput = await execFileAsync(helper, [], {
      encoding: "utf8",
      env: fixture.environment,
    });
    assert.equal(tokenOutput.stdout, `${tokenSentinel}\n`);
    const jsonOutput = await execFileAsync(helper, ["--json"], {
      encoding: "utf8",
      env: fixture.environment,
    });
    assert.deepEqual(JSON.parse(jsonOutput.stdout), {
      expires_at: "2030-01-02T03:04:05Z",
      token: tokenSentinel,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("codex-gh keeps the installation token in a protected ephemeral config", async () => {
  const fixture = await createFixture();
  const installer = join(recipeRoot, "install-github-app-helpers.sh");
  try {
    await execFileAsync(installer, [], {
      encoding: "utf8",
      env: {
        CODEX_GITHUB_HELPER_INSTALL_DIR: fixture.bin,
        HOME: fixture.environment.HOME,
        PATH: fixture.environment.PATH,
      },
    });
    await writeExecutable(join(fixture.bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
tr '\\0' '\\n' </proc/$$/cmdline >"$CAPTURE_DIRECTORY/gh.argv"
env >"$CAPTURE_DIRECTORY/gh.env"
printf '%s\n' "$GH_CONFIG_DIR" >"$CAPTURE_DIRECTORY/gh.config-path"
stat -c '%a' "$GH_CONFIG_DIR" >"$CAPTURE_DIRECTORY/gh.directory-mode"
stat -c '%a' "$GH_CONFIG_DIR/hosts.yml" >"$CAPTURE_DIRECTORY/gh.file-mode"
cp "$GH_CONFIG_DIR/hosts.yml" "$CAPTURE_DIRECTORY/gh.hosts.yml"
if [[ "\${FAKE_GH_MODE:-success}" == "failure" ]]; then
  printf 'synthetic gh failure\n' >&2
  exit 41
fi
printf '{"name":"example-repo"}\n'
`);

    const result = await execFileAsync(
      "bash",
      ["-x", join(fixture.bin, "codex-gh"), "api", "repos/example-org/example-repo"],
      {
        encoding: "utf8",
        env: {
          ...fixture.environment,
          CODEX_GH_REPO: "example-org/example-repo",
          GITHUB_TOKEN: parentTokenSentinel,
          GH_TOKEN: parentTokenSentinel,
        },
      },
    );
    assert.equal(result.stdout, '{"name":"example-repo"}\n');
    assert.doesNotMatch(
      result.stderr,
      new RegExp(`${jwtSentinel}|${tokenSentinel}|${parentTokenSentinel}`, "u"),
    );

    const argv = await readFile(join(fixture.capture, "gh.argv"), "utf8");
    const environment = await readFile(join(fixture.capture, "gh.env"), "utf8");
    const curlArgv = await readFile(join(fixture.capture, "curl.argv"), "utf8");
    const hosts = await readFile(join(fixture.capture, "gh.hosts.yml"), "utf8");
    const authDirectory = (await readFile(
      join(fixture.capture, "gh.config-path"),
      "utf8",
    )).trim();
    assert.doesNotMatch(argv, new RegExp(`${tokenSentinel}|${parentTokenSentinel}`, "u"));
    assert.doesNotMatch(environment, new RegExp(`${tokenSentinel}|${parentTokenSentinel}`, "u"));
    assert.match(
      curlArgv,
      /--data\n\{"permissions":\{"contents":"write","pull_requests":"write"\},"repositories":\["example-repo"\]\}\n/u,
    );
    assert.match(hosts, new RegExp(`oauth_token: '${tokenSentinel}'`, "u"));
    assert.equal(await readFile(join(fixture.capture, "gh.directory-mode"), "utf8"), "700\n");
    assert.equal(await readFile(join(fixture.capture, "gh.file-mode"), "utf8"), "600\n");
    assert.ok(authDirectory.startsWith(`${fixture.runtime}/codex-gh.`));
    await absent(authDirectory);

    await assert.rejects(
      execFileAsync(
        join(fixture.bin, "codex-gh"),
        ["api", "repos/example-org/example-repo"],
        {
          encoding: "utf8",
          env: { ...fixture.environment, FAKE_GH_MODE: "failure" },
        },
      ),
      error => {
        assert.equal(error.code, 41);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "synthetic gh failure\n");
        return true;
      },
    );
    const failedAuthDirectory = (await readFile(
      join(fixture.capture, "gh.config-path"),
      "utf8",
    )).trim();
    await absent(failedAuthDirectory);

    const linkedRuntime = join(fixture.root, "linked-runtime");
    await symlink(fixture.runtime, linkedRuntime);
    await assert.rejects(
      execFileAsync(join(fixture.bin, "codex-gh"), ["api", "user"], {
        encoding: "utf8",
        env: { ...fixture.environment, TMPDIR: linkedRuntime },
      }),
      error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(
          error.stderr,
          "GitHub CLI credential runtime directory is unavailable.\n",
        );
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});
