# Scheduled Markdown prompt-job recipe

This role-neutral overlay adds editable Markdown schedules to an Agent Boot
definition. Spread `scheduledJobs.assets` into the definition's `assets` and
`scheduledJobs.installSteps` into its ordered `steps` after Codex installation,
authentication, and profile verification. The recipe initially installs exact
service/timer units with every timer disabled.

The manifest is versioned and non-secret. Every job requires exactly these
fields:

| Field | Contract |
| --- | --- |
| `id` | Stable lowercase systemd-safe identifier |
| `prompt` | Normalized `.md` path beneath the manifest directory |
| `onCalendar` | Lexically safe expression accepted by `systemd-analyze calendar` |
| `randomizedDelaySeconds` | Integer from 0 through 86,400 |
| `persistent` | Whether systemd catches up a missed calendar run |
| `timeoutSeconds` | Integer from 30 through 43,200 |
| `model` | Explicit supported model (`gpt-5.6-sol` or `gpt-5.6-terra`) |
| `reasoningEffort` | Explicit supported Codex reasoning effort |
| `workingDirectory` | Existing normalized path beneath the account home |
| `logRetention` | Number of concise run records retained, from 1 through 100 |
| `overlapGroup` | Shared lock identifier; use `heavy-work` for costly jobs |
| `effectPolicy` | Version 1 requires `read-only` |

`read-only` is enforced by launching Codex with approvals disabled, the
read-only sandbox, ignored user configuration and rules, and an ephemeral
session. A role prompt may propose an external effect, but it cannot perform
one through this scheduler. Delivery requires a separate deterministic
executor with an immutable payload, durable operation identity, reservation,
receipt validation, and authoritative reconciliation. Credential placement
remains a separate protected definition concern.

## Harmless live canary and reboot gate

Run these only after the normal Agent Boot runner has reached terminal success.
The example identity is deliberately generic:

```bash
sudo -n /usr/local/sbin/agent-boot-prompt-jobs canary \
  --account my-user \
  --manifest scheduled-prompts/jobs.json \
  --job canary

/usr/local/sbin/agent-boot-prompt-jobs status \
  --account my-user \
  --manifest scheduled-prompts/jobs.json
```

The canary must report `passed`, and `systemctl status
agent-boot-prompt-job-canary.service` must show that exact installed system
service namespace. It is still safe at this point because the recipe installed
the timers disabled.

Enable and deterministically re-arm the complete validated set:

```bash
sudo -n /usr/local/sbin/agent-boot-prompt-jobs install \
  --account my-user \
  --manifest scheduled-prompts/jobs.json \
  --enabled

/usr/local/sbin/agent-boot-prompt-jobs status \
  --account my-user \
  --manifest scheduled-prompts/jobs.json
```

For every job, status must show `enabled: true`, `active: true`, and at least one
finite next realtime or monotonic trigger. Reboot once, rerun `status`, and
require the same evidence before connecting any prompt-produced proposal to a
separately reviewed deterministic effect executor. Repeat installation always
restarts each enabled timer; it does not rely on `enable --now` to re-arm an
already-active timer.

Use `run-once` instead of `canary` for an intentionally authorized role job.
Remove only the exact registered namespace with:

```bash
sudo -n /usr/local/sbin/agent-boot-prompt-jobs uninstall \
  --account my-user \
  --manifest scheduled-prompts/jobs.json
```
