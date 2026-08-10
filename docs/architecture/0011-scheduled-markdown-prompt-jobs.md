# 0011: Scheduled Markdown prompt jobs

Status: Accepted

## Context

Small agent appliances need recurring model-assisted work without copying a
role-specific scheduler into each definition. The editable policy belongs in a
local Markdown prompt and registry. Credential custody, unit mutation, process
lifecycle, recovery, and status need deterministic product ownership.

## Decision

Agent Boot packages `@agent-boot/scheduled-prompt-jobs` and its system launcher
in the private runner bundle. `scheduledPromptJobs()` is a definition recipe:
it places the definition-local `jobs.json` and Markdown files through ordinary
assembly assets, then runs the target installer as an ordered automatic step.

The version-1 manifest is exact-key and fail-closed. Before any unit change the
target validates all identifiers, settings, systemd calendars, canonical prompt
paths, file custody/modes, and working directories. It renders one exact
service/timer pair per stable ID, statically verifies the complete candidate,
and replaces only the registry-owned unit set with rollback. Enabled installs
restart every timer and require enabled, active, finite-next-trigger evidence.

Each service closes stdin at the systemd boundary; the runner sends the bounded
prompt bytes to Codex and closes the pipe, replaces the inherited environment,
uses the declared working directory and timeout, and settles the managed
process group. Per-job and overlap-group advisory locks serialize work. Codex
output is drained and discarded; only bounded result metadata is retained.

Version 1 accepts only `effectPolicy=read-only`. Codex runs with approvals
disabled, the read-only sandbox, user configuration and rules ignored, and an
ephemeral session. External writes are outside this component: they require a
separate deterministic executor that owns immutable payload identity, durable
reservation, receipt validation, and authoritative reconciliation before a
prompt-produced proposal can have an effect. Credentials remain outside the
manifest, model process, and prompt-job component.

## Consequences

Future roles add one Markdown file and one manifest entry, then rerun the same
installer. They can inspect, canary, enable, re-arm, run once, and uninstall the
same service namespace without embedding systemd or subprocess logic in role
prompts. The first live authorization remains a separate operator gate: run a
read-only canary, verify the exact system service, enable and prove finite
timers, reboot, and prove the same state. Any later external-effect delivery
remains a separately reviewed deterministic-executor integration.
