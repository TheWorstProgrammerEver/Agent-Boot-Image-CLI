import type { CommandIo } from "../validate-command.js";

export const printAssemblyPlan = (
  io: CommandIo,
  input: {
    readonly assemblyId: string;
    readonly artifactSha256?: string;
    readonly catalogId: string;
    readonly dryRun: boolean;
  },
): void => {
  io.stdout("Agent image plan");
  io.stdout(`  assembly: ${input.assemblyId}`);
  io.stdout(`  OS lock: ${input.catalogId}`);
  if (input.artifactSha256 !== undefined) {
    io.stdout(`  verified OS artifact: sha256:${input.artifactSha256}`);
  }
  io.stdout("  target: /dev/disk/by-id/[redacted]");
  io.stdout("  guardrail overrides: none");
  if (input.dryRun) {
    io.stdout("  dry-run: no secrets, downloads, commands, devices, or output directories accessed");
  }
};
