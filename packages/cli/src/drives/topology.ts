import type { BlockDevice, DriveSnapshot } from "@agent-boot/os-linux";

export const deviceMaps = (snapshot: DriveSnapshot): {
  readonly byKernelName: ReadonlyMap<string, BlockDevice>;
  readonly byPath: ReadonlyMap<string, BlockDevice>;
} => ({
  byKernelName: new Map(snapshot.devices.map((device) => [device.kernelName, device])),
  byPath: new Map(snapshot.devices.map((device) => [device.canonicalPath, device])),
});

const ancestorsOf = (
  device: BlockDevice,
  byKernelName: ReadonlyMap<string, BlockDevice>,
): Set<string> => {
  const ancestors = new Set<string>();
  let current: BlockDevice | undefined = device;
  while (current !== undefined && !ancestors.has(current.kernelName)) {
    ancestors.add(current.kernelName);
    current = current.parentKernelName === undefined
      ? undefined
      : byKernelName.get(current.parentKernelName);
  }
  return ancestors;
};

export const isActiveRootAncestor = (
  target: BlockDevice,
  snapshot: DriveSnapshot,
): boolean => {
  const { byKernelName } = deviceMaps(snapshot);
  return snapshot.devices
    .filter((device) => device.mountpoints.includes("/"))
    .some((root) => ancestorsOf(root, byKernelName).has(target.kernelName));
};

export const mountedDescendants = (
  target: BlockDevice,
  snapshot: DriveSnapshot,
): readonly BlockDevice[] => {
  const { byKernelName } = deviceMaps(snapshot);
  return snapshot.devices.filter((device) =>
    device.mountpoints.length > 0 && ancestorsOf(device, byKernelName).has(target.kernelName));
};
