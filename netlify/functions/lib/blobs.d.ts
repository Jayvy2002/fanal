declare module "@netlify/blobs" {
  export function getStore(nameOrOpts: string | { name: string; consistency?: string }): {
    getWithMetadata: (
      key: string,
      opts: { type: "json" },
    ) => Promise<{ data: unknown; etag: string } | null>;
    setJSON: (key: string, value: unknown, opts?: { onlyIfMatch?: string }) => Promise<unknown>;
  };
}
