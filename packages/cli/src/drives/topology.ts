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
  const visiting = new Set<string>();

  const visit = (current: BlockDevice): boolean => {
    if (visiting.has(current.kernelName)) return false;
    if (ancestors.has(current.kernelName)) return true;
    visiting.add(current.kernelName);
    ancestors.add(current.kernelName);
    for (const parentKernelName of current.parentKernelNames) {
      const parent = byKernelName.get(parentKernelName);
      if (parent === undefined || !visit(parent)) return false;
    }
    visiting.delete(current.kernelName);
    return true;
  };

  return visit(device) ? ancestors : undefined;
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
): readonly BlockDevice[] | undefined => {
  const { byKernelName } = deviceMaps(snapshot);
  const mounted = snapshot.devices.filter((device) => device.mountpoints.length > 0);
  const descendants: BlockDevice[] = [];
  for (const device of mounted) {
    const ancestors = ancestorsOf(device, byKernelName);
    if (ancestors === undefined) return undefined;
    if (ancestors.has(target.kernelName)) descendants.push(device);
  }
  return descendants;
};
