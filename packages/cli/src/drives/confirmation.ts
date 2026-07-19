import { DriveGuardrailError } from "./errors.js";
import {
  assertPreparedImageTargetPlan,
  type ImageTargetPlan,
} from "./preflight.js";

const STABLE_TARGET_PREFIX = "/dev/disk/by-id/";

export type ConfirmedImageTargetPlan = ImageTargetPlan;

export type ImageTargetAcknowledgement =
  | { readonly yes: true }
  | {
      readonly yes: false;
      readonly request: (prompt: string) => Promise<string>;
    };

export interface ImageTargetConfirmation {
  readonly acknowledgement: ImageTargetAcknowledgement;
  readonly writeLine: (line: string) => void;
}

const confirmedPlans = new WeakSet<ImageTargetPlan>();

export const formatImageTargetPlan = (plan: ImageTargetPlan): string[] => [
  "Destructive image target plan",
  `  stable target: ${STABLE_TARGET_PREFIX}[redacted]`,
  `  resolved whole disk: ${plan.resolvedTarget}`,
  `  size: ${String(plan.sizeBytes)} bytes (within explicit limit)`,
  "  model: matches explicit expectation",
  "  serial: [redacted]; matches explicit expectation",
  "  removable media: confirmed",
  "  transport: matches explicit expectation",
  "  active root ancestry: clear",
  "  mounted descendants: none",
  `  acknowledgement token: ${plan.confirmationToken}`,
];

export const confirmImageTargetPlan = async (
  plan: ImageTargetPlan,
  confirmation: ImageTargetConfirmation,
): Promise<ConfirmedImageTargetPlan> => {
  assertPreparedImageTargetPlan(plan);
  for (const line of formatImageTargetPlan(plan)) confirmation.writeLine(line);

  if (!confirmation.acknowledgement.yes) {
    const phrase = `ERASE ${plan.confirmationToken}`;
    const response = await confirmation.acknowledgement.request(
      `Type ${phrase} to acknowledge irreversible media erasure:`,
    );
    if (response !== phrase) {
      throw new DriveGuardrailError(
        "confirmation-rejected",
        "Image target acknowledgement was rejected.",
      );
    }
  }
  confirmedPlans.add(plan);
  return plan;
};

export const assertConfirmedImageTargetPlan = (plan: ConfirmedImageTargetPlan): void => {
  if (!confirmedPlans.has(plan)) throw new TypeError("Image target plan has not been acknowledged.");
};
