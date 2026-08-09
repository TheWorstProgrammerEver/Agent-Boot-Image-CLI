import { command } from "../command.js";
import { asset, type AssetInput } from "../resources.js";
import { automatic, type SequenceStepInput } from "../steps.js";

export interface ScheduledPromptSource {
  readonly assetId: string;
  readonly path: string;
  readonly source: string;
}

export interface ScheduledPromptJobsOptions {
  readonly accountUsername: string;
  readonly id?: string;
  readonly installMode: "disabled" | "enabled";
  readonly manifestSource: string;
  readonly prompts: readonly ScheduledPromptSource[];
  readonly workingDirectory?: string;
}

export interface ScheduledPromptJobsSlice {
  readonly assets: readonly AssetInput[];
  readonly installSteps: readonly SequenceStepInput[];
}

const manifestPath = "scheduled-prompts/jobs.json";

export const scheduledPromptJobs = (
  options: ScheduledPromptJobsOptions,
): ScheduledPromptJobsSlice => {
  const id = options.id ?? "scheduled-prompt-jobs";
  const assets = [
    asset(`${id}-manifest`, options.manifestSource, {
      placement: { path: manifestPath, scope: "user-home" },
    }),
    ...options.prompts.map(prompt => asset(prompt.assetId, prompt.source, {
      placement: { path: `scheduled-prompts/${prompt.path}`, scope: "user-home" },
    })),
  ];
  const install = automatic(
    `${id}-install`,
    command(
      "sudo",
      [
        "-n",
        "/usr/local/sbin/agent-boot-prompt-jobs",
        "install",
        "--account",
        options.accountUsername,
        "--manifest",
        manifestPath,
        options.installMode === "enabled" ? "--enabled" : "--disabled",
      ],
      {
        workingDirectory: {
          path: options.workingDirectory ?? "workspace",
          scope: "user-home",
        },
      },
    ),
  );
  return { assets, installSteps: [install] };
};
