import { ArtifactAcquisitionError, type ArtifactAcquisitionErrorCode } from "./errors.js";

export const throwIfArtifactCanceled = (cancellation?: AbortSignal): void => {
  if (cancellation?.aborted === true) throw new ArtifactAcquisitionError("canceled");
};

export const artifactFailure = (
  error: unknown,
  cancellation: AbortSignal | undefined,
  fallback: ArtifactAcquisitionErrorCode,
): ArtifactAcquisitionError => {
  if (cancellation?.aborted === true) return new ArtifactAcquisitionError("canceled");
  return error instanceof ArtifactAcquisitionError
    ? error
    : new ArtifactAcquisitionError(fallback);
};
