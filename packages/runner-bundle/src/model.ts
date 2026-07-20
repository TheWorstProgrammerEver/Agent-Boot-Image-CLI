export const RUNNER_BUNDLE_SCHEMA_VERSION = 1 as const;

export type BundleEntry =
  | {
      readonly kind: "directory";
      readonly mode: string;
      readonly path: string;
      readonly targetPath: string;
    }
  | {
      readonly kind: "file";
      readonly mode: string;
      readonly path: string;
      readonly sha256: string;
      readonly size: number;
      readonly targetPath: string;
    }
  | {
      readonly kind: "symlink";
      readonly linkTarget: string;
      readonly path: string;
      readonly targetPath: string;
    };

export interface NodeRuntimePin {
  readonly distributionSha256: string;
  readonly ltsCodename: string;
  readonly treeSha256: string;
  readonly version: string;
}

export interface RunnerServiceAccount {
  readonly group: string;
  readonly homeDirectory: string;
  readonly username: string;
  readonly workingDirectory: string;
}

export interface RunnerBundleManifest {
  readonly bundleSha256: string;
  readonly compatibility: {
    readonly architecture: "arm64";
    readonly assemblySchemaVersions: readonly [1];
    readonly checkpointSchemaVersions: readonly [2];
    readonly platform: "linux";
  };
  readonly entries: readonly BundleEntry[];
  readonly format: "agent-boot-runner-bundle";
  readonly node: NodeRuntimePin;
  readonly schemaVersion: typeof RUNNER_BUNDLE_SCHEMA_VERSION;
  readonly service: {
    readonly ttyPath: "/dev/tty1";
    readonly unitName: "agent-boot-runner.service";
  };
}

export interface BuildRunnerBundleOptions {
  readonly account: RunnerServiceAccount;
  readonly node: NodeRuntimePin;
  readonly nodeRuntimeDirectory: string;
  readonly outputDirectory: string;
  readonly packageDirectories?: Readonly<Record<"process" | "protocol" | "runner" | "runner-bundle", string>>;
}
