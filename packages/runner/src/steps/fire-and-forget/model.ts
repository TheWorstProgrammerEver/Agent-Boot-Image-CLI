import type { SpawnHost, SpawnResult } from "@agent-boot/process";

import type {
  FireAndForgetProcessEvent,
  ProcessIdentity,
  RunnerCheckpoint,
  RunnerPlanIdentity,
} from "../../state/index.js";

export interface FireAndForgetPolicy {
  readonly acceptanceWindowMs: number;
  readonly maxLaunchAttempts: number;
  readonly terminationGraceMs: number;
}

export interface ProcessIdentityHost {
  capture(pid: number): Promise<ProcessIdentity | undefined>;
  currentBootId(): Promise<string>;
  matches(identity: ProcessIdentity): Promise<boolean>;
  terminate(
    identity: ProcessIdentity,
    signal: NodeJS.Signals,
    graceMs: number,
  ): Promise<boolean>;
}

export interface FireAndForgetStateStore {
  checkpointFireAndForgetProcess(
    plan: RunnerPlanIdentity,
    event: FireAndForgetProcessEvent,
  ): Promise<RunnerCheckpoint>;
}

export interface FireAndForgetSupervisorOptions {
  readonly commandHost: SpawnHost;
  readonly identityHost: ProcessIdentityHost;
  readonly plan: RunnerPlanIdentity;
  readonly policy: FireAndForgetPolicy;
  readonly stateStore: FireAndForgetStateStore;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface TrackedProcessResult {
  readonly error: boolean;
  readonly result: SpawnResult;
}
