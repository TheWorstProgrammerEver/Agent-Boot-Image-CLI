# ADR 0001: CDK-like synthesis boundary

- Status: Accepted
- Date: 2026-07-19

## Context

Agent definitions need an expressive TypeScript API, while the image builder and
target runner need a deterministic, versioned input. Allowing definition code to
leak into adapters or onto the target would couple evaluation to privileged image
operations and make the runtime contract impossible to validate independently.

## Decision

Definitions follow a CDK-like two-phase model. Trusted TypeScript runs only on
the imaging host and builds an in-memory definition graph. The provider-neutral
`synth` package converts that graph into an immutable assembly described by the
`assembly` package.

Synthesis performs no image downloads, filesystem mounting, device access,
privileged process execution, provider calls, or secret materialization. It emits
intent only. Every consumer validates the assembly version and schema before use.
The CLI may compose synthesis with host adapters only after synthesis completes.

The target receives the assembly and private runner artifacts. It never receives
or evaluates the original TypeScript definition.

## Consequences

- A definition can be synthesized and tested without an OS adapter.
- Assemblies become the only serialized contract between host and target phases.
- Host-specific discovery and mutation cannot influence provider-neutral synth.
- Future assembly changes require explicit versioning and compatibility policy.
