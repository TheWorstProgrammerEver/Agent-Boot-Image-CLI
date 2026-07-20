import type { ArtifactResponse, ArtifactTransport } from "./model.js";

export type ArtifactFetch = typeof fetch;

export class NativeArtifactTransport implements ArtifactTransport {
  readonly #fetch: ArtifactFetch;

  constructor(fetchImplementation: ArtifactFetch = fetch) {
    this.#fetch = fetchImplementation;
  }

  async request({ cancellation, offset, url }: {
    readonly cancellation?: AbortSignal;
    readonly offset: number;
    readonly url: string;
  }): Promise<ArtifactResponse> {
    const response = await this.#fetch(url, {
      ...(offset === 0 ? {} : { headers: { Range: `bytes=${String(offset)}-` } }),
      redirect: "manual",
      ...(cancellation === undefined ? {} : { signal: cancellation }),
    });
    return {
      body: response.body ?? undefined,
      header: name => response.headers.get(name) ?? undefined,
      status: response.status,
    };
  }
}
