# Root-spec definition-of-done traceability

This table maps every RYA-121 definition-of-done item to its owning work,
reviewed PR, automated evidence, and physical evidence where applicable. PR
numbers refer to `TheWorstProgrammerEver/Agent-Boot-Image-CLI` unless noted.

| Root definition of done | Child issue and reviewed PR | Automated evidence | Physical evidence |
| --- | --- | --- | --- |
| Valid TypeScript definition compiles and passes runtime validation | RYA-127 / [PR #3](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/3), RYA-124 / [PR #6](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/6), RYA-125 / [PR #7](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/7) | [`definition-valid.test.mjs`](../test/definition-valid.test.mjs), [`cli-validation.test.mjs`](../test/cli-validation.test.mjs), example typecheck and docs-release smoke | Definition loaded during RYA-146 image preparation |
| Invalid definitions fail before destructive operation | RYA-124 / PR #6, RYA-143 / [PR #22](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/22) | [`definition-rejection.test.mjs`](../test/definition-rejection.test.mjs), [`image-command.test.mjs`](../test/image-command.test.mjs) zero-boundary assertions | A preflight size probe failed before the physical unit or write and was safely retried |
| Synthesis is deterministic, versioned, and redacted | RYA-126 / [PR #2](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/2), RYA-133 / [PR #8](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/8) | [`protocol-valid.test.mjs`](../test/protocol-valid.test.mjs), [`synth-assembly.test.mjs`](../test/synth-assembly.test.mjs), non-destructive repeat hash | Dry-run and live RYA-146 runs produced the same assembly ID |
| CLI safely writes and validates an approved target | RYA-140 / [PR #16](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/16), RYA-141 / [PR #18](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/18), RYA-143 / PR #22, RYA-146 / [PR #28](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/28) | Drive, raw-I/O, transaction, customization, and orchestration suites | Exact approved write, full read-back, customization, fsck, and clean unmount passed |
| Supported Raspberry Pi boots generated media | RYA-146 / PR #28 | RYA-145 guarded simulation / [PR #23](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/23) | Fresh image booted on Raspberry Pi 5 |
| Account and network bootstrap complete | RYA-135 / [PR #20](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/20), RYA-189 / [PR #29](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/29) | Adapter and runner-network suites | Account, Wi-Fi, and SSH availability passed before and after reboot |
| Runner starts from private Node runtime | RYA-138 / [PR #19](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/19) | [`runner-bundle.test.mjs`](../test/runner-bundle.test.mjs) | ARM64 runtime and service started successfully |
| Console progress is visible | RYA-138 / PR #19, RYA-189 / PR #29 | Bundle service/progress and console ownership tests | Redacted runner progress and manual flow appeared on tty1 |
| Environment persists across separately spawned steps | RYA-130 / [PR #9](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/9) | [`runner-engine.test.mjs`](../test/runner-engine.test.mjs) | Later Codex, secret, prompt, and verification steps inherited account context |
| Manual Codex authentication works on physical console | RYA-132 / [PR #12](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/12), RYA-137 / [PR #15](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/15) | [`runner-manual.test.mjs`](../test/runner-manual.test.mjs), Codex bootstrap tests | Device-auth gate completed on tty1 without recording the code |
| Codex YOLO permissions precede first prompt | RYA-137 / PR #15 | [`runner-codex-profile.test.mjs`](../test/runner-codex-profile.test.mjs), [`runner-codex-provider.test.mjs`](../test/runner-codex-provider.test.mjs) | Installed runtime profile and ordered journal proved both gates before prompt |
| Prompt templates hydrate and execute from rendered location | RYA-134 / [PR #13](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/13), RYA-197 / [PR #31](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/31) | [`runner-prompts-providers.test.mjs`](../test/runner-prompts-providers.test.mjs), prompt mismatch tests in [`synth-assembly.test.mjs`](../test/synth-assembly.test.mjs) | Validation prompt rendered, executed, and produced expected safe output |
| Bootstrap secrets move transactionally without manual cleanup | RYA-136 / [PR #14](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/14) | [`runner-user-secret.test.mjs`](../test/runner-user-secret.test.mjs) with fault/reboot cases | Secret transaction succeeded and bootstrap source directory became empty |
| State resumes safely after representative reboot/interruption | RYA-129 / [PR #5](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/5), RYA-130 / PR #9, RYA-188 / [PR #27](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/27) | State recovery, runner re-entry, guarded integration, and post-cognition retry tests | Post-success reboot resumed terminal state without prompt replay; live mid-auth restart remains RYA-195 |
| Final health passes or exposes actionable failure | RYA-129 / PR #5, RYA-138 / PR #19, RYA-143 / PR #22 | State-transition, service-status, image failure/recovery, and redaction tests | `runner-succeeded`, successful systemd exit, persistent output, and bounded state/status passed |
| Implementation is represented by reviewed children and focused PRs | RYA-122 through RYA-147, plus focused validation follow-ups RYA-184, RYA-186, RYA-188, RYA-189, RYA-190, RYA-193, and RYA-197 | Package boundaries and this checklist | RYA-146 PR #28 is the redacted physical handoff |
| Routine tests avoid real block devices and leaked process/state | RYA-122 / [PR #1](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/1), RYA-128 / [PR #4](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/4), RYA-145 / PR #23 | Guarded non-destructive suite, `/dev` preload negative controls, process cleanup, temp-root checks, hardened CI | Physical work was isolated to explicitly approved RYA-146; it is not run by CI |

## Additional required guardrails

- [RYA-193](https://linear.app/ryan-hayward/issue/RYA-193/agent-boot-prove-authored-post-cognition-setup-recipes)
  and [PR #32](https://github.com/TheWorstProgrammerEver/Agent-Boot-Image-CLI/pull/32)
  prove the recommended deterministic-step versus authored-cognition split,
  ordered post-auth execution, deterministic post-provider verification,
  failure/reboot recovery, redaction, and cleanup.
- [RYA-197](https://linear.app/ryan-hayward/issue/RYA-197/agent-boot-validate-prompt-template-variables-before-image-write)
  and PR #31 prove prompt declarations and placeholders are checked before
  assembly publication or image write.
- [RYA-146 physical evidence](validation/rya-146-physical-image-and-first-boot.md)
  is redacted public evidence. Exact target approval, private identifiers,
  credentials, and local operation paths remain outside the repository.

[`test/docs-release.test.mjs`](../test/docs-release.test.mjs) asserts that all
17 root items remain represented and that the required RYA-193, RYA-197, PR,
test, and physical-evidence references remain present.
