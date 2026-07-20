import type { SpawnHost } from "@agent-boot/process";

import { ArtifactCache } from "./artifact-cache.js";
import { resolveCatalogArtifact } from "./catalog-resolver.js";
import type { AcquiredOsArtifact, ArtifactTransport } from "./model.js";
import { NativeArtifactTransport } from "./transport.js";
import { XzMetadataInspector } from "./xz-metadata.js";

export interface AcquireOsArtifactOptions {
  readonly cacheDirectory: string;
  readonly cancellation?: AbortSignal;
  readonly commandHost: SpawnHost;
  readonly lockPollMs?: number;
  readonly lockTimeoutMs?: number;
  readonly transport?: ArtifactTransport;
}

export const acquireOsArtifact = async (
  lockInput: unknown,
  options: AcquireOsArtifactOptions,
): Promise<AcquiredOsArtifact> => {
  const lock = resolveCatalogArtifact(lockInput);
  const cache = new ArtifactCache({
    cacheDirectory: options.cacheDirectory,
    inspector: new XzMetadataInspector(options.commandHost),
    ...(options.lockPollMs === undefined ? {} : { lockPollMs: options.lockPollMs }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    transport: options.transport ?? new NativeArtifactTransport(),
  });
  return cache.acquire(lock, options.cancellation);
};
