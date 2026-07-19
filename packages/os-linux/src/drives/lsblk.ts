import type { BlockDevice } from "./model.js";

interface LsblkNode extends Record<string, unknown> {
  readonly children?: unknown;
}

const object = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid lsblk JSON: ${context} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid lsblk JSON: ${field} must be non-empty text.`);
  }
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid lsblk JSON: ${field} contains control characters.`);
  }
  return normalized;
};

const optionalText = (value: unknown, field: string): string | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  return text(value, field);
};

const size = (value: unknown, field: string): number => {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid lsblk JSON: ${field} must be a positive safe integer.`);
  }
  return parsed;
};

const removable = (value: unknown, field: string): boolean => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error(`Invalid lsblk JSON: ${field} must be boolean-like.`);
};

const mountpoints = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid lsblk JSON: ${field} must be an array.`);
  }
  return value.flatMap((mountpoint, index) => {
    if (mountpoint === null) return [];
    return [text(mountpoint, `${field}[${String(index)}]`)];
  });
};

const kernelName = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

type DeviceFields = Omit<BlockDevice, "parentKernelNames">;

interface DeviceBuilder {
  readonly device: DeviceFields;
  readonly parentKernelNames: Set<string>;
}

const sameDevice = (left: DeviceFields, right: DeviceFields): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const parseNode = (
  input: unknown,
  inheritedParent: string | undefined,
  path: string,
  devices: Map<string, DeviceBuilder>,
): void => {
  const node = object(input, path) as LsblkNode;
  const name = kernelName(text(node.kname, `${path}.kname`));
  const explicitParent = optionalText(node.pkname, `${path}.pkname`);
  const model = optionalText(node.model, `${path}.model`);
  const serial = optionalText(node.serial, `${path}.serial`);
  const transport = optionalText(node.tran, `${path}.tran`);
  const canonicalPath = text(node.path, `${path}.path`);
  if (!canonicalPath.startsWith("/dev/")) {
    throw new Error(`Invalid lsblk JSON: ${path}.path must be an absolute device path.`);
  }
  const device: DeviceFields = {
    canonicalPath,
    kernelName: name,
    ...(model === undefined ? {} : { model }),
    mountpoints: mountpoints(node.mountpoints, `${path}.mountpoints`),
    removable: removable(node.rm, `${path}.rm`),
    ...(serial === undefined ? {} : { serial }),
    sizeBytes: size(node.size, `${path}.size`),
    ...(transport === undefined ? {} : { transport }),
    type: text(node.type, `${path}.type`),
  };
  const existing = devices.get(name);
  if (existing !== undefined && !sameDevice(existing.device, device)) {
    throw new Error("Invalid lsblk JSON: repeated kernel device identity is inconsistent.");
  }
  const builder = existing ?? { device, parentKernelNames: new Set<string>() };
  if (inheritedParent !== undefined) builder.parentKernelNames.add(inheritedParent);
  if (explicitParent !== undefined) builder.parentKernelNames.add(kernelName(explicitParent));
  devices.set(name, builder);

  if (node.children === undefined) return;
  if (!Array.isArray(node.children)) {
    throw new Error(`Invalid lsblk JSON: ${path}.children must be an array.`);
  }
  node.children.forEach((child, index) => {
    parseNode(child, name, `${path}.children[${String(index)}]`, devices);
  });
};

export const parseLsblkJson = (source: string): BlockDevice[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Invalid lsblk JSON: output could not be parsed.");
  }
  const root = object(parsed, "root");
  if (!Array.isArray(root.blockdevices)) {
    throw new Error("Invalid lsblk JSON: blockdevices must be an array.");
  }

  const devices = new Map<string, DeviceBuilder>();
  root.blockdevices.forEach((node, index) => {
    parseNode(node, undefined, `blockdevices[${String(index)}]`, devices);
  });
  return [...devices.values()].map(({ device, parentKernelNames }) => ({
    ...device,
    parentKernelNames: [...parentKernelNames].sort((left, right) => left.localeCompare(right)),
  }));
};
