"use client";

import type { BoardSnapshot, BoardViewport } from "./board-types";
import type { StoredAsset } from "./local-board-store";

export const CANVASROOM_BOARD_FORMAT = "canvasroom-board" as const;
export const CANVASROOM_BOARD_SCHEMA_VERSION = 2 as const;
export const CANVASROOM_BOARD_EXTENSION = ".canvasroom";
export const CANVASROOM_BOARD_MIME = "application/vnd.canvasroom+json";
export const CANVASROOM_BOARD_ACCEPT = ".canvasroom,.canvasroom.json,.json,application/json";

const MAX_BOARD_FILE_BYTES = 350 * 1024 * 1024;
const ASSET_KINDS = new Set<StoredAsset["kind"]>([
  "image",
  "video",
  "audio",
  "pdf",
  "link",
  "file",
]);

export interface CanvasRoomPortableAsset
  extends Omit<StoredAsset, "boardId" | "blob"> {
  dataUrl?: string;
}

export interface CanvasRoomBoardDocument {
  format: typeof CANVASROOM_BOARD_FORMAT;
  schemaVersion: typeof CANVASROOM_BOARD_SCHEMA_VERSION;
  generator: {
    name: "CanvasRoom";
    version: 1;
  };
  board: {
    title: string;
    snapshot: BoardSnapshot;
    viewport: BoardViewport;
  };
  assets: CanvasRoomPortableAsset[];
  exportedAt: string;
}

export interface CanvasRoomBoardSummary {
  title: string;
  objectCount: number;
  attachmentCount: number;
  exportedAt: string;
}

interface FileWritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  name?: string;
  createWritable(): Promise<FileWritableLike>;
}

interface BoardFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileHandleLike>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function isBoardSnapshot(value: unknown): value is BoardSnapshot {
  const snapshot = asRecord(value);
  return Boolean(
    snapshot &&
    typeof snapshot.version === "number" &&
    Number.isFinite(snapshot.version) &&
    Array.isArray(snapshot.elements),
  );
}

function normalizeViewport(value: unknown): BoardViewport {
  const viewport = asRecord(value);
  if (
    viewport &&
    typeof viewport.x === "number" &&
    Number.isFinite(viewport.x) &&
    typeof viewport.y === "number" &&
    Number.isFinite(viewport.y) &&
    typeof viewport.zoom === "number" &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0
  ) {
    return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  }
  return { x: 0, y: 0, zoom: 1 };
}

function normalizeAsset(value: unknown): CanvasRoomPortableAsset | null {
  const asset = asRecord(value);
  if (
    !asset ||
    typeof asset.id !== "string" ||
    typeof asset.name !== "string" ||
    typeof asset.kind !== "string" ||
    !ASSET_KINDS.has(asset.kind as StoredAsset["kind"])
  ) {
    return null;
  }

  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind as StoredAsset["kind"],
    mimeType: typeof asset.mimeType === "string" ? asset.mimeType : "application/octet-stream",
    size: typeof asset.size === "number" && Number.isFinite(asset.size) ? asset.size : 0,
    createdAt: typeof asset.createdAt === "string" ? asset.createdAt : new Date(0).toISOString(),
    sourceUrl: typeof asset.sourceUrl === "string" ? asset.sourceUrl : undefined,
    preview: typeof asset.preview === "string" ? asset.preview : undefined,
    dataUrl: typeof asset.dataUrl === "string" && asset.dataUrl.startsWith("data:")
      ? asset.dataUrl
      : undefined,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("An attachment could not be encoded."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("An attachment could not be read."));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("An embedded attachment is malformed.");
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = /^data:([^;,]+)/.exec(header)?.[1] || "application/octet-stream";
  const decoded = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export function createCanvasRoomFileName(title: string): string {
  const stem = title
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "canvasroom-board";
  return `${stem}${CANVASROOM_BOARD_EXTENSION}`;
}

export async function createCanvasRoomDocument(input: {
  title: string;
  snapshot: BoardSnapshot;
  viewport: BoardViewport;
  assets: StoredAsset[];
}): Promise<CanvasRoomBoardDocument> {
  const portableAssets = await Promise.all(input.assets.map(async (asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt,
    sourceUrl: asset.sourceUrl,
    preview: asset.preview,
    dataUrl: asset.blob ? await blobToDataUrl(asset.blob) : undefined,
  })));

  return {
    format: CANVASROOM_BOARD_FORMAT,
    schemaVersion: CANVASROOM_BOARD_SCHEMA_VERSION,
    generator: { name: "CanvasRoom", version: 1 },
    board: {
      title: input.title.trim() || "Untitled board",
      snapshot: input.snapshot,
      viewport: input.viewport,
    },
    assets: portableAssets,
    exportedAt: new Date().toISOString(),
  };
}

export function parseCanvasRoomDocument(value: unknown): CanvasRoomBoardDocument {
  const document = asRecord(value);
  const board = asRecord(document?.board);
  if (
    document?.format !== CANVASROOM_BOARD_FORMAT ||
    !board ||
    !isBoardSnapshot(board.snapshot)
  ) {
    throw new Error("That file is not a CanvasRoom board.");
  }

  const assets = Array.isArray(document.assets)
    ? document.assets.map(normalizeAsset).filter((asset): asset is CanvasRoomPortableAsset => Boolean(asset))
    : [];

  return {
    format: CANVASROOM_BOARD_FORMAT,
    schemaVersion: CANVASROOM_BOARD_SCHEMA_VERSION,
    generator: { name: "CanvasRoom", version: 1 },
    board: {
      title: typeof board.title === "string" && board.title.trim() ? board.title.trim() : "Untitled board",
      snapshot: board.snapshot,
      viewport: normalizeViewport(board.viewport),
    },
    assets,
    exportedAt: typeof document.exportedAt === "string" ? document.exportedAt : new Date(0).toISOString(),
  };
}

export async function readCanvasRoomFile(file: File): Promise<CanvasRoomBoardDocument> {
  if (file.size > MAX_BOARD_FILE_BYTES) {
    throw new Error("CanvasRoom board files must be smaller than 350 MB.");
  }
  try {
    return parseCanvasRoomDocument(JSON.parse(await file.text()));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("That file is not valid JSON.");
    throw error;
  }
}

export async function restoreCanvasRoomAssets(
  assets: CanvasRoomPortableAsset[],
  boardId: string,
): Promise<StoredAsset[]> {
  return assets.map((asset) => ({
    id: asset.id,
    boardId,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt,
    sourceUrl: asset.sourceUrl,
    preview: asset.preview,
    blob: asset.dataUrl ? dataUrlToBlob(asset.dataUrl) : undefined,
  }));
}

export function summarizeCanvasRoomDocument(
  document: CanvasRoomBoardDocument,
): CanvasRoomBoardSummary {
  return {
    title: document.board.title,
    objectCount: document.board.snapshot.elements.length,
    attachmentCount: document.assets.length,
    exportedAt: document.exportedAt,
  };
}

function downloadDocument(document: CanvasRoomBoardDocument, fileName: string): void {
  const blob = new Blob([JSON.stringify(document)], { type: CANVASROOM_BOARD_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function saveCanvasRoomDocument(
  document: CanvasRoomBoardDocument,
  fileName: string,
): Promise<"file-system" | "download" | "cancelled"> {
  const blob = new Blob([JSON.stringify(document)], { type: CANVASROOM_BOARD_MIME });
  const pickerWindow = window as BoardFilePickerWindow;
  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: "CanvasRoom board",
          accept: { [CANVASROOM_BOARD_MIME]: [CANVASROOM_BOARD_EXTENSION] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "file-system";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }

  downloadDocument(document, fileName);
  return "download";
}
