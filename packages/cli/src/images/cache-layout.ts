import { join, resolve } from "node:path";

export interface ArtifactCachePaths {
  readonly artifact: string;
  readonly artifactDirectory: string;
  readonly lock: string;
  readonly lockDirectory: string;
  readonly partial: string;
  readonly partialDirectory: string;
  readonly quarantineDirectory: string;
}

export const cachePathsFor = (cacheDirectory: string, sha256: string): ArtifactCachePaths => {
  const root = join(resolve(cacheDirectory), "v1");
  const artifactDirectory = join(root, "sha256", sha256.slice(0, 2));
  const lockDirectory = join(root, "locks");
  const partialDirectory = join(root, "partial");
  return {
    artifact: join(artifactDirectory, `${sha256}.img.xz`),
    artifactDirectory,
    lock: join(lockDirectory, `${sha256}.lock`),
    lockDirectory,
    partial: join(partialDirectory, `${sha256}.part`),
    partialDirectory,
    quarantineDirectory: join(root, "quarantine"),
  };
};
