import { createHash } from "node:crypto";

import type { BlockDevice, DriveInspector, DriveSnapshot } from "@agent-boot/os-linux";

import { DriveGuardrailError } from "./errors.js";
import { activeRootAncestors, deviceMaps, mountedDescendants } from "./topology.js";

const STABLE_TARGET_PREFIX = "/dev/disk/by-id/";

export interface ImageTargetConstraints {
  readonly expectedModel: string;
  readonly expectedRemovable: boolean;
  readonly expectedSerial: string;
  readonly expectedTransport: string;
  readonly maxSizeBytes: number;
}

export interface ImageTargetRequest {
  readonly constraints: ImageTargetConstraints;
  readonly stableTarget: string;
}

export interface ImageTargetPlan {
  readonly confirmationToken: string;
  readonly resolvedTarget: string;
  readonly sizeBytes: number;
  readonly stableTarget: string;
}

export interface AuthorizedImageTarget {
  readonly resolvedTarget: string;
  readonly sizeBytes: number;
  readonly stableTarget: string;
}

interface PlanState {
  readonly constraints: ImageTargetConstraints;
  readonly identity: string;
  readonly target: BlockDevice;
}

const planStates = new WeakMap<ImageTargetPlan, PlanState>();

function fail(
  code: ConstructorParameters<typeof DriveGuardrailError>[0],
  message: string,
): never {
  throw new DriveGuardrailError(code, message);
}

const requiredText = (value: string, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid-constraints", `${name} must be explicit non-empty text.`);
  }
  return value.trim();
};

const validateRequest = (request: ImageTargetRequest): ImageTargetRequest => {
  if (!request.stableTarget.startsWith(STABLE_TARGET_PREFIX) ||
      request.stableTarget.slice(STABLE_TARGET_PREFIX.length).includes("/")) {
    fail("unstable-target", "Target must be an explicit /dev/disk/by-id path.");
  }
  if (!request.constraints.expectedRemovable) {
    fail("invalid-constraints", "The removable-media guardrail must be enabled.");
  }
  if (!Number.isSafeInteger(request.constraints.maxSizeBytes) ||
      request.constraints.maxSizeBytes <= 0) {
    fail("invalid-constraints", "Maximum target size must be a positive safe integer.");
  }
  requiredText(request.constraints.expectedModel, "Expected model");
  requiredText(request.constraints.expectedSerial, "Expected serial");
  requiredText(request.constraints.expectedTransport, "Expected transport");
  return request;
};

const identity = (device: BlockDevice): string => createHash("sha256")
  .update(JSON.stringify({
    canonicalPath: device.canonicalPath,
    kernelName: device.kernelName,
    model: device.model ?? null,
    removable: device.removable,
    serial: device.serial ?? null,
    sizeBytes: device.sizeBytes,
    transport: device.transport ?? null,
    type: device.type,
  }))
  .digest("hex");

const resolveTarget = (
  request: ImageTargetRequest,
  snapshot: DriveSnapshot,
): BlockDevice => {
  const rootAncestors = activeRootAncestors(snapshot);
  if (rootAncestors === undefined) {
    fail("active-root-unresolved", "Active root ancestry could not be established.");
  }
  const link = snapshot.stableLinks.find(({ path }) => path === request.stableTarget);
  if (link === undefined) fail("target-not-found", "Stable target could not be resolved.");
  const target = deviceMaps(snapshot).byPath.get(link.resolvedPath);
  if (target === undefined) fail("target-not-found", "Resolved target is not in block-device topology.");
  if (target.type !== "disk") fail("not-whole-disk", "Resolved target is not a whole disk.");
  if (rootAncestors.has(target.kernelName)) {
    fail("active-system-disk", "Target contains the active root filesystem.");
  }
  const mounted = mountedDescendants(target, snapshot);
  if (mounted === undefined) {
    fail("descendant-mount-unresolved", "Mounted-device ancestry could not be established.");
  }
  if (mounted.length > 0) {
    fail("descendant-mounted", "Target or one of its descendants is mounted.");
  }
  if (target.model !== request.constraints.expectedModel.trim()) {
    fail("model-mismatch", "Target model does not match the explicit expectation.");
  }
  if (target.serial !== request.constraints.expectedSerial.trim()) {
    fail("serial-mismatch", "Target serial does not match the explicit expectation.");
  }
  if (!target.removable) fail("not-removable", "Target is not removable media.");
  if (target.transport !== request.constraints.expectedTransport.trim()) {
    fail("transport-mismatch", "Target transport does not match the explicit expectation.");
  }
  if (target.sizeBytes > request.constraints.maxSizeBytes) {
    fail("size-limit-exceeded", "Target exceeds the explicit maximum size.");
  }
  return target;
};

export const prepareImageTargetPlan = async (
  request: ImageTargetRequest,
  inspector: DriveInspector,
): Promise<ImageTargetPlan> => {
  const validated = validateRequest(request);
  const target = resolveTarget(validated, await inspector.inspect());
  const targetIdentity = identity(target);
  const plan = Object.freeze({
    confirmationToken: targetIdentity.slice(0, 12),
    resolvedTarget: target.canonicalPath,
    sizeBytes: target.sizeBytes,
    stableTarget: validated.stableTarget,
  });
  planStates.set(plan, {
    constraints: { ...validated.constraints },
    identity: targetIdentity,
    target: { ...target, mountpoints: [...target.mountpoints] },
  });
  return plan;
};
export const assertPreparedImageTargetPlan = (plan: ImageTargetPlan): void => {
  if (!planStates.has(plan)) throw new TypeError("Image target plan was not created by preflight.");
};

export const recheckImageTarget = async (
  plan: ImageTargetPlan,
  inspector: DriveInspector,
): Promise<AuthorizedImageTarget> => {
  const state = planStates.get(plan);
  if (state === undefined) throw new TypeError("Image target plan was not created by preflight.");
  const request = { constraints: state.constraints, stableTarget: plan.stableTarget };
  const current = resolveTarget(request, await inspector.inspect());
  if (identity(current) !== state.identity || current.canonicalPath !== state.target.canonicalPath) {
    fail("identity-changed", "Target identity changed after acknowledgement.");
  }
  return {
    resolvedTarget: current.canonicalPath,
    sizeBytes: current.sizeBytes,
    stableTarget: plan.stableTarget,
  };
};
