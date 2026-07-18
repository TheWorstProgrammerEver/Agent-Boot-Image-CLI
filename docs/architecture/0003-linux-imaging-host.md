# ADR 0003: Linux imaging-host constraint

- Status: Accepted
- Date: 2026-07-19

## Context

Image customization will eventually rely on Linux filesystem, process, and image
tooling. Pretending those operations are portable would either hide substantial
platform differences or encourage untested execution paths around safety checks.

## Decision

The image-building CLI supports Linux imaging hosts only. Host capability checks
must fail closed before an adapter performs discovery or mutation. Linux-specific
behavior lives in `@agent-boot/os-linux`; provider-neutral assembly, definition,
synthesis, process contracts, and runner contracts do not import it.

Development on other platforms may run provider-neutral checks, synthesis tests,
and fakes. It may not claim image-building support. CI remains non-destructive and
runs only builds, static checks, boundary checks, and tests inside an isolated
container without host device access.

## Consequences

- Host support is explicit and testable instead of nominally cross-platform.
- Linux behavior can be replaced by fakes in routine tests.
- Adding another host OS requires a new adapter and a separate support decision.
- Target Linux distributions remain a separate compatibility concern.
