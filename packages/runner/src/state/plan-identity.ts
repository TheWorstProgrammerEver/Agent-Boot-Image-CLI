import { createHash } from "node:crypto";

import type { RunnerPlanIdentity } from "./model.js";

export const identifyRunnerPlan = (
  plan: { readonly agentId: string; readonly schemaVersion: number },
  serializedPlan: string | Uint8Array,
): RunnerPlanIdentity => ({
  agentId: plan.agentId,
  planSha256: createHash("sha256").update(serializedPlan).digest("hex"),
  schemaVersion: plan.schemaVersion,
});

export const samePlanIdentity = (
  left: RunnerPlanIdentity,
  right: RunnerPlanIdentity,
): boolean =>
  left.agentId === right.agentId &&
  left.planSha256 === right.planSha256 &&
  left.schemaVersion === right.schemaVersion;
