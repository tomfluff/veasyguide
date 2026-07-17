// IndexedDB cache of finished analyses, keyed by videoKey (size|duration|WxH).
//
// Why: three of five personas hit the same wall — every reopen re-analyzes from zero
// (~25 min for a 90-minute lecture). localStorage can't hold a big lecture's activity
// list (5-10 MB quota); IndexedDB is the platform's store for exactly this.
//
// Every function swallows failures into null/undefined: a cache must never be the reason
// the app fails — private browsing modes and storage-denied contexts just analyze again.
// ponytail: eviction is "keep the newest 20"; an LRU with sizes can come if anyone hits it.

import type { MomentsFile } from "../analyzer/momentsFile";

const DB = "veasyguide";
const STORE = "analyses";
const KEEP = 20;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheGet(key: string): Promise<MomentsFile | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result?.file as MomentsFile) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(key: string, file: MomentsFile): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ key, savedAt: file.savedAt, file });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  // Evict beyond the newest KEEP. Separate transaction; best-effort.
  const db2 = await openDb();
  if (!db2) return;
  try {
    const tx = db2.transaction(STORE, "readwrite");
    const idx = tx.objectStore(STORE).index("savedAt");
    const all = idx.getAllKeys();
    all.onsuccess = () => {
      const keys = all.result; // savedAt-ascending primary keys
      for (let i = 0; i < keys.length - KEEP; i++) tx.objectStore(STORE).delete(keys[i]);
    };
  } catch {
    /* cache is best-effort */
  }
}
