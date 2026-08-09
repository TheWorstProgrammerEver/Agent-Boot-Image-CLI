# Scheduled Markdown prompt jobs

`@agent-boot/scheduled-prompt-jobs` is the target-side mechanism behind the
`scheduledPromptJobs()` definition recipe. An appliance definition owns its
editable Markdown prompts and one non-secret versioned manifest. This package
owns validation, Codex process lifecycle, locks, bounded operational records,
systemd unit publication, timer re-arming, status, canaries, and removal.

The runner validates the complete manifest, every calendar expression, every
prompt, and every working directory before it verifies or changes a unit. It
rejects linked, escaping, missing, non-account-owned, or group/world-writable
inputs. A failed unit publication or timer transition restores the prior exact
unit set and timer policy.

Each Codex process receives its prompt on stdin followed by EOF, an explicit
working directory, a replaced minimal environment, and a bounded timeout. It
runs with approvals disabled, the read-only sandbox, user configuration and
rules ignored, and an ephemeral session. External effects require a separate
deterministic executor with durable reservation and reconciliation. The process
runs in a managed group so cancellation and timeout settle descendants.
Both a per-job lock and the declared overlap-group lock are held; use the
role-neutral `heavy-work` group to serialize resource-intensive jobs on a small
host.

The component discards Codex stdout and stderr. It stores only a bounded JSONL
history and concise `last-run.json` under
`~/.local/state/agent-boot-prompt-jobs/<job-id>/`; prompt bytes and arbitrary
response bodies are not copied into those records.

See the maintained [scheduled-prompt-jobs example](../../examples/scheduled-prompt-jobs/README.md)
for the schema, recipe, canary, reboot gate, and operator commands.
