export type ArtifactAcquisitionErrorCode =
  | "cache-access"
  | "checksum-mismatch"
  | "download-interrupted"
  | "download-size"
  | "http-response"
  | "invalid-range"
  | "lock-timeout"
  | "metadata-inspection"
  | "redirect-rejected"
  | "unpinned-lock";

const messages: Record<ArtifactAcquisitionErrorCode, string> = {
  "cache-access": "The OS artifact cache could not be accessed safely.",
  "checksum-mismatch": "The downloaded OS artifact failed checksum verification.",
  "download-interrupted": "The OS artifact download was interrupted and can be resumed.",
  "download-size": "The OS artifact download did not match its pinned byte length.",
  "http-response": "The OS artifact server returned an unacceptable response.",
  "invalid-range": "The OS artifact server returned an invalid resume range.",
  "lock-timeout": "Timed out waiting for another OS artifact cache operation.",
  "metadata-inspection": "The verified OS artifact metadata could not be inspected.",
  "redirect-rejected": "OS artifact redirects are not permitted by cache policy.",
  "unpinned-lock": "The OS lock does not exactly match a curated catalog artifact.",
};

export class ArtifactAcquisitionError extends Error {
  readonly code: ArtifactAcquisitionErrorCode;

  constructor(code: ArtifactAcquisitionErrorCode) {
    super(messages[code]);
    this.name = "ArtifactAcquisitionError";
    this.code = code;
  }
}
