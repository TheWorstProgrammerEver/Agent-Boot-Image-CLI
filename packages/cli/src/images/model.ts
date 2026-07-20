export interface ArtifactRequest {
  readonly cancellation?: AbortSignal;
  readonly offset: number;
  readonly url: string;
}

export interface ArtifactResponse {
  readonly body: AsyncIterable<Uint8Array> | undefined;
  readonly status: number;
  header(name: string): string | undefined;
}

export interface ArtifactTransport {
  request(request: ArtifactRequest): Promise<ArtifactResponse>;
}

export interface ArtifactImageMetadata {
  readonly compressionFormat: "xz";
  readonly compressedByteLength: number;
  readonly imageFormat: "raw";
  readonly imageByteLength: number;
}

export interface ArtifactMetadataInspector {
  inspect(
    path: string,
    compressedByteLength: number,
    cancellation?: AbortSignal,
  ): Promise<ArtifactImageMetadata>;
}

export interface AcquiredOsArtifact extends ArtifactImageMetadata {
  readonly path: string;
  readonly sha256: string;
  readonly source: "cache" | "download";
}
