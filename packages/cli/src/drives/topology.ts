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
): Set<string> | undefined => {
  const ancestors = new Set<string>();
  let current = device;
  while (!ancestors.has(current.kernelName)) {
    ancestors.add(current.kernelName);
    if (current.parentKernelName === undefined) return ancestors;
    const parent = byKernelName.get(current.parentKernelName);
    if (parent === undefined) return undefined;
    current = parent;
  }
  return undefined;
};

export const activeRootAncestors = (snapshot: DriveSnapshot): ReadonlySet<string> | undefined => {
  const { byKernelName } = deviceMaps(snapshot);
  const roots = snapshot.devices.filter((device) => device.mountpoints.includes("/"));
  if (roots.length === 0) return undefined;

  const ancestors = new Set<string>();
  for (const root of roots) {
    const rootAncestors = ancestorsOf(root, byKernelName);
    if (rootAncestors === undefined) return undefined;
    rootAncestors.forEach((kernelName) => ancestors.add(kernelName));
  }
  return ancestors;
};

export const mountedDescendants = (
  target: BlockDevice,
  snapshot: DriveSnapshot,
): readonly BlockDevice[] => {
  const { byKernelName } = deviceMaps(snapshot);
  return snapshot.devices.filter((device) =>
    device.mountpoints.length > 0 &&
    ancestorsOf(device, byKernelName)?.has(target.kernelName) === true);
};
