"use client";

import type { StoredAsset } from "./local-board-store";

const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function guessAssetKind(file: Pick<File, "type" | "name">): StoredAsset["kind"] {
  const type = file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  return "file";
}

async function imageThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return undefined;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("This image could not be read."));
      element.src = url;
    });

    const maximum = 640;
    const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createStoredAsset(boardId: string, file: File): Promise<StoredAsset> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than the 250 MB local attachment limit.`);
  }

  const kind = guessAssetKind(file);
  return {
    id: newId("asset"),
    boardId,
    name: file.name,
    kind,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: new Date().toISOString(),
    blob: file,
    preview: kind === "image" ? await imageThumbnail(file) : undefined,
  };
}

export function createLinkAsset(boardId: string, sourceUrl: string): StoredAsset {
  const url = new URL(sourceUrl);
  return {
    id: newId("link"),
    boardId,
    name: url.hostname.replace(/^www\./, ""),
    kind: "link",
    mimeType: "text/uri-list",
    size: 0,
    createdAt: new Date().toISOString(),
    sourceUrl: url.toString(),
  };
}

export function getAssetOpenUrl(asset: StoredAsset) {
  if (asset.sourceUrl) return asset.sourceUrl;
  if (asset.blob) return URL.createObjectURL(asset.blob);
  return asset.preview;
}
