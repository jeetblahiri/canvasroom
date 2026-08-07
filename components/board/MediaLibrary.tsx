"use client";

import {
  FileAudio,
  FilePlus2,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { StoredAsset } from "../../lib/local-board-store";

type MediaLibraryProps = {
  open: boolean;
  assets: StoredAsset[];
  onClose: () => void;
  onUpload: (files: File[]) => Promise<void>;
  onAddLink: (url: string) => Promise<void>;
  onPlace: (asset: StoredAsset) => void;
  onDelete: (asset: StoredAsset) => void;
};

const kindIcon = {
  image: ImageIcon,
  video: Film,
  audio: FileAudio,
  pdf: FileText,
  link: Link2,
  file: FilePlus2,
} as const;

function formatBytes(bytes: number) {
  if (!bytes) return "Link";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaLibrary({ open, assets, onClose, onUpload, onAddLink, onPlace, onDelete }: MediaLibraryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      await onUpload(Array.from(files));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The attachment could not be added.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function addLink() {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
      await onAddLink(parsed.toString());
      setUrl("");
    } catch (linkError) {
      setError(linkError instanceof Error && linkError.message !== "Invalid URL" ? linkError.message : "Enter a valid web address.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <aside className="side-panel media-panel" aria-label="Media library">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Board assets</span>
          <h2>Media library</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close media library"><X size={18} /></button>
      </div>

      <button className="drop-zone" onClick={() => inputRef.current?.click()} disabled={busy}>
        <span className="drop-zone-icon"><Upload size={20} /></span>
        <strong>{busy ? "Adding files…" : "Upload media"}</strong>
        <span>Images, PDF, audio, video, or documents</span>
      </button>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.txt,.md,.doc,.docx,.ppt,.pptx"
        onChange={(event) => void upload(event.target.files)}
      />

      <div className="link-input-row">
        <Link2 size={16} aria-hidden="true" />
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void addLink(); }}
          placeholder="Paste a link"
          aria-label="Link to add"
        />
        <button onClick={() => void addLink()} aria-label="Add link" disabled={busy || !url.trim()}><Plus size={17} /></button>
      </div>

      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="asset-list">
        {assets.length === 0 ? (
          <div className="empty-panel-state">
            <ImageIcon size={22} />
            <strong>Your board is ready for more</strong>
            <span>Attach references, videos, audio, or useful links.</span>
          </div>
        ) : assets.map((asset) => {
          const Icon = kindIcon[asset.kind];
          return (
            <article className="asset-card" key={asset.id}>
              <button className="asset-main" onClick={() => onPlace(asset)} title="Place on board">
                {asset.kind === "image" && asset.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.preview} alt="" />
                ) : <span className={`asset-type asset-${asset.kind}`}><Icon size={20} /></span>}
                <span className="asset-copy">
                  <strong>{asset.name}</strong>
                  <small>{asset.kind.toUpperCase()} · {formatBytes(asset.size)}</small>
                </span>
              </button>
              <button className="asset-delete" onClick={() => onDelete(asset)} aria-label={`Delete ${asset.name}`}><Trash2 size={15} /></button>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
