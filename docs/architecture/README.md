# Architecture decisions

These records define the safety and package boundaries for the Agent Boot
workspace before product behavior is added.

| Layer | May depend on | Must remain independent from |
| --- | --- | --- |
| `assembly` | None | Definitions, host adapters, CLI, runner implementation |
| `definition` | `assembly` | OS adapters, process implementations, runner |
| `synth` | `assembly`, `definition` | OS adapters, process implementations, runner |
| `process` | None | OS adapters and product workflows |
| `os-linux` | `assembly`, `process` | Definition evaluation and synthesis |
| `runner` | `assembly`, `process` | Definition evaluation and host OS adapters |
| `cli` | All composition dependencies | N/A; this is the composition root |

`config/package-boundaries.json` is the machine-readable form of this table.
`npm run check:boundaries` validates both declared workspace dependencies and
TypeScript imports against it.

## Records

1. [CDK-like synthesis boundary](0001-cdk-like-synthesis-boundary.md)
2. [Trusted definition threat model](0002-trusted-definition-threat-model.md)
3. [Linux imaging-host constraint](0003-linux-imaging-host.md)
4. [Private target runner](0004-private-target-runner.md)
5. [Secret materialization and redaction boundary](0005-secret-redaction-boundary.md)
6. [Separate process adapters](0006-separate-process-adapters.md)
