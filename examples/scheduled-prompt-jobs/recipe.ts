import { scheduledPromptJobs } from "@agent-boot/definition";

export const scheduledJobs = scheduledPromptJobs({
  accountUsername: "my-user",
  installMode: "disabled",
  manifestSource: "./jobs.json",
  prompts: [
    {
      assetId: "scheduled-canary-prompt",
      path: "canary.md",
      source: "./prompts/canary.md",
    },
    {
      assetId: "scheduled-maintenance-report-prompt",
      path: "maintenance-report.md",
      source: "./prompts/maintenance-report.md",
    },
  ],
});
