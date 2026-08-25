import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PolyLedger } from "./types";

const KEY = "ledger";
const STORE = "fanal-paper-poly";
const LOCAL_FILE = path.join(os.tmpdir(), "fanal-paper-poly-ledger.json");

export type StoreKind = "blobs" | "file";

export type Loaded = {
  ledger: PolyLedger | null;
  etag: string | undefined;
  kind: StoreKind;
};

type BlobStore = {
  getWithMetadata: (
    key: string,
    opts: { type: "json" },
  ) => Promise<{ data: unknown; etag: string } | null>;
  setJSON: (key: string, value: unknown, opts?: { onlyIfMatch?: string }) => Promise<unknown>;
};

let kindMemo: StoreKind | null = null;
let blobsMemo: BlobStore | null | undefined;

async function tryBlobs(): Promise<BlobStore | null> {
  if (blobsMemo !== undefined) return blobsMemo;
  try {
    const mod = await import("@netlify/blobs");
    const store = mod.getStore({ name: STORE, consistency: "strong" }) as BlobStore;
    blobsMemo = store;
    return store;
  } catch {
    blobsMemo = null;
    return null;
  }
}

export async function storeKind(): Promise<StoreKind> {
  if (kindMemo) return kindMemo;
  const s = await tryBlobs();
  kindMemo = s ? "blobs" : "file";
  return kindMemo;
}

async function loadFile(): Promise<Loaded> {
  try {
    const raw = await readFile(LOCAL_FILE, "utf8");
    return { ledger: JSON.parse(raw) as PolyLedger, etag: undefined, kind: "file" };
  } catch {
    return { ledger: null, etag: undefined, kind: "file" };
  }
}

export async function loadLedger(): Promise<Loaded> {
  const blobs = await tryBlobs();
  if (blobs) {
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const hit = await blobs.getWithMetadata(KEY, { type: "json" });
        kindMemo = "blobs";
        if (!hit || hit.data == null) return { ledger: null, etag: undefined, kind: "blobs" };
        return { ledger: hit.data as PolyLedger, etag: hit.etag, kind: "blobs" };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 40 * (i + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("blobs_load_failed");
  }
  return loadFile();
}

export async function saveLedger(ledger: PolyLedger, etag?: string): Promise<boolean> {
  const blobs = await tryBlobs();
  if (blobs) {
    try {
      const opts = etag ? { onlyIfMatch: etag } : undefined;
      await blobs.setJSON(KEY, ledger, opts);
      kindMemo = "blobs";
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/412|precondition|onlyIfMatch|if-match|conflict/i.test(msg)) return false;
      throw err instanceof Error ? err : new Error("blobs_save_failed");
    }
  }
  await mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  const tmp = `${LOCAL_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger));
  await rename(tmp, LOCAL_FILE);
  kindMemo = "file";
  return true;
}
