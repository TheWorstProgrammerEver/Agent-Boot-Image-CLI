import type { DriveInspector } from "@agent-boot/os-linux";

import {
  assertConfirmedImageTargetPlan,
  confirmImageTargetPlan,
  type ConfirmedImageTargetPlan,
  type ImageTargetConfirmation,
} from "./confirmation.js";
import {
  prepareImageTargetPlan,
  recheckImageTarget,
  type AuthorizedImageTarget,
  type ImageTargetRequest,
} from "./preflight.js";

export const withRecheckedImageTarget = async <T>(
  plan: ConfirmedImageTargetPlan,
  inspector: DriveInspector,
  beginLockedOperation: (target: AuthorizedImageTarget) => Promise<T>,
): Promise<T> => {
  assertConfirmedImageTargetPlan(plan);
  const target = await recheckImageTarget(plan, inspector);
  return beginLockedOperation(target);
};

export const runGuardedImageTarget = async <T>(
  request: ImageTargetRequest,
  inspector: DriveInspector,
  confirmation: ImageTargetConfirmation,
  beginLockedOperation: (target: AuthorizedImageTarget) => Promise<T>,
): Promise<T> => {
  const plan = await prepareImageTargetPlan(request, inspector);
  const confirmed = await confirmImageTargetPlan(plan, confirmation);
  return withRecheckedImageTarget(confirmed, inspector, beginLockedOperation);
};
