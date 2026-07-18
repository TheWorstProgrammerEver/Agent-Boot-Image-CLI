# ADR 0004: Private target runner

- Status: Accepted
- Date: 2026-07-19

## Context

The target needs a small runtime to apply the synthesized assembly after first
boot. Treating that runtime as a public SDK would expose implementation details,
couple definitions to target mechanics, and widen the compatibility surface.

## Decision

`@agent-boot/runner` is a private workspace package and an internal image artifact,
not a published API. Its stable input is the versioned provider-neutral assembly.
The target contains neither definition source nor a definition evaluator.

The runner receives only the capabilities needed for its current step. Provider
credentials and imaging-host state are not copied to the target by default. The
runner will persist redacted, resumable progress through explicit contracts rather
than exposing implementation modules as extension points.

## Consequences

- Runner internals may evolve behind the assembly compatibility boundary.
- Target images have a smaller executable and credential surface.
- Definitions cannot call runner implementation details directly.
- Any future public target extension API needs its own decision and versioning.
