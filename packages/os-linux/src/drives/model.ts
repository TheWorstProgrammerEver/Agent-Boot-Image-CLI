export interface BlockDevice {
  readonly canonicalPath: string;
  readonly kernelName: string;
  readonly model?: string;
  readonly mountpoints: readonly string[];
  readonly parentKernelName?: string;
  readonly removable: boolean;
  readonly serial?: string;
  readonly sizeBytes: number;
  readonly transport?: string;
  readonly type: string;
}

export interface StableDeviceLink {
  readonly path: string;
  readonly resolvedPath: string;
}

export interface DriveSnapshot {
  readonly devices: readonly BlockDevice[];
  readonly stableLinks: readonly StableDeviceLink[];
}

export interface DriveInspector {
  inspect(): Promise<DriveSnapshot>;
}
