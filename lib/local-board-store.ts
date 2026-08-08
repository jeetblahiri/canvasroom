"use client";

import type { BoardViewport } from "./board-types";

const DATABASE_NAME = "canvas-room-local";
const DATABASE_VERSION = 1;
const BOARDS_STORE = "boards";
const ASSETS_STORE = "assets";

export type StoredBoard<TSnapshot = unknown> = {
  id: string;
  title: string;
  snapshot: TSnapshot;
  viewport?: BoardViewport;
  createdAt: string;
  updatedAt: string;
};

export type StoredAsset = {
  id: string;
  boardId: string;
  name: string;
  kind: "image" | "video" | "audio" | "pdf" | "link" | "file";
  mimeType: string;
  size: number;
  createdAt: string;
  sourceUrl?: string;
  blob?: Blob;
  preview?: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Local board storage is unavailable in this browser."));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BOARDS_STORE)) {
        database.createObjectStore(BOARDS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(ASSETS_STORE)) {
        const store = database.createObjectStore(ASSETS_STORE, { keyPath: "id" });
        store.createIndex("boardId", "boardId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local storage."));
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Local storage operation failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local storage operation was cancelled."));
  });
}

export async function saveBoard<TSnapshot>(board: StoredBoard<TSnapshot>) {
  const database = await openDatabase();
  const transaction = database.transaction(BOARDS_STORE, "readwrite");
  transaction.objectStore(BOARDS_STORE).put(board);
  await completeTransaction(transaction);
  database.close();
}

export async function loadBoard<TSnapshot>(id: string): Promise<StoredBoard<TSnapshot> | null> {
  const database = await openDatabase();
  const transaction = database.transaction(BOARDS_STORE, "readonly");
  const request = transaction.objectStore(BOARDS_STORE).get(id);

  const result = await new Promise<StoredBoard<TSnapshot> | null>((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as StoredBoard<TSnapshot> | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Unable to load this board."));
  });

  database.close();
  return result;
}

export async function listBoards<TSnapshot = unknown>(): Promise<StoredBoard<TSnapshot>[]> {
  const database = await openDatabase();
  const transaction = database.transaction(BOARDS_STORE, "readonly");
  const request = transaction.objectStore(BOARDS_STORE).getAll();

  const result = await new Promise<StoredBoard<TSnapshot>[]>((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as StoredBoard<TSnapshot>[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror = () => reject(request.error ?? new Error("Unable to list local boards."));
  });

  database.close();
  return result;
}

export async function putAsset(asset: StoredAsset) {
  const database = await openDatabase();
  const transaction = database.transaction(ASSETS_STORE, "readwrite");
  transaction.objectStore(ASSETS_STORE).put(asset);
  await completeTransaction(transaction);
  database.close();
}

export async function listAssets(boardId: string): Promise<StoredAsset[]> {
  const database = await openDatabase();
  const transaction = database.transaction(ASSETS_STORE, "readonly");
  const request = transaction.objectStore(ASSETS_STORE).index("boardId").getAll(boardId);

  const result = await new Promise<StoredAsset[]>((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as StoredAsset[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error ?? new Error("Unable to load attachments."));
  });

  database.close();
  return result;
}

export async function deleteAsset(id: string) {
  const database = await openDatabase();
  const transaction = database.transaction(ASSETS_STORE, "readwrite");
  transaction.objectStore(ASSETS_STORE).delete(id);
  await completeTransaction(transaction);
  database.close();
}

export async function requestDurableLocalStorage() {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function downloadJsonFile(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function readJsonFile<T>(file: File): Promise<T> {
  if (file.size > 25 * 1024 * 1024) throw new Error("Board files must be smaller than 25 MB.");
  const parsed = JSON.parse(await file.text()) as T;
  if (!parsed || typeof parsed !== "object") throw new Error("This is not a valid board file.");
  return parsed;
}
