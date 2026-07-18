# `create-agent validate`

Validate a trusted Agent Boot TypeScript definition before synthesis or device
operations are available:

```console
create-agent validate ./my-agent.ts
```

> **Security warning:** the definition and every module it imports are trusted
> executable code. Validation executes that code with the CLI process's host
> permissions. Review its full import graph before running this command.

The command requires a module with exactly one runtime export named `default`,
normalizes that value through `@agent-boot/definition`, checks schema/protocol
compatibility, and inspects local reference metadata. Relative references are
rooted at the definition file. Validation does not read referenced contents,
serialize the definition to output, run definition commands, contact providers,
download images, or inspect devices.

Exit codes are stable for automation:

| Code | Meaning |
| ---: | --- |
| 0 | Definition is valid. |
| 2 | Export, schema, or reference metadata is invalid. |
| 3 | Definition protocol is incompatible with this CLI. |
| 4 | The module or reference metadata could not be loaded operationally. |
| 64 | Command usage is invalid. |
