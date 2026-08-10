# GitHub App helpers

This directory is the maintained Agent Boot source for the GitHub App helpers
used by managed-agent definitions. The helpers mint repository- and
permission-narrowed installation tokens without placing the App JWT or minted
token in a child process's arguments or exported environment.

`codex-github-token` disables ambient curl configuration before giving curl its
authorization header through a config read from standard input. `codex-gh`
gives GitHub CLI a mode-`0600` configuration in an owner-only `mktemp`
directory after rejecting symlinked or attacker-writable non-sticky runtime
ancestry, removes inherited token variables, and removes the directory on every
normal, failed, or trapped exit. All helpers disable shell tracing before
handling credential material and project bounded errors.

## Install or refresh

From a clean checkout at the reviewed Agent Boot revision:

```sh
./recipes/github-app-helpers/install-github-app-helpers.sh --dry-run
./recipes/github-app-helpers/install-github-app-helpers.sh
for helper in codex-github-token codex-github-askpass codex-gh; do
  cmp "recipes/github-app-helpers/$helper" "$HOME/.local/bin/$helper"
done
```

The install command replaces all three copies. Run the byte comparisons before
using a managed agent whose installed helpers predate this recipe. Do not copy
helpers from a retired setup repository.

Keep the App private key and identifier configuration under
`$HOME/.config/codex-github` as owner-only inputs. Then validate without
printing a token:

```sh
codex-github-token --repo OWNER/REPO --expires-at
CODEX_GH_REPO=OWNER/REPO codex-gh api repos/OWNER/REPO --jq .full_name
```

`--repo`, `--repositories`, `--permissions-json`, `--full-permissions`,
`--expires-at`, and `--json` retain their existing behavior. The default
permissions remain `contents:write` and `pull_requests:write`; callers should
continue requesting only the repositories and permissions needed by one
operation. Token and JSON output modes intentionally write their requested
result to standard output for askpass and explicit callers. Do not invoke those
modes from routine logs or diagnostics.
