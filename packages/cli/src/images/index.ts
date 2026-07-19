export { acquireOsArtifact, type AcquireOsArtifactOptions } from "./acquire.js";
export { ArtifactAcquisitionError, type ArtifactAcquisitionErrorCode } from "./errors.js";
export type {
  AcquiredOsArtifact,
  ArtifactImageMetadata,
  ArtifactRequest,
  ArtifactResponse,
  ArtifactTransport,
} from "./model.js";
export { NativeArtifactTransport, type ArtifactFetch } from "./transport.js";
export { XzMetadataInspector } from "./xz-metadata.js";
