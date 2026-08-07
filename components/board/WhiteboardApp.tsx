"use client";

import {
  ArrowUpRight,
  Circle,
  Download,
  Eraser,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  PenTool,
  Redo2,
  Save,
  Square,
  TabletSmartphone,
  Type,
  Undo2,
  Upload,
  Wifi,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";

import { DeviceLinkPanel } from "./DeviceLinkPanel";
import { MediaLibrary } from "./MediaLibrary";
import { RecordingPanel } from "./RecordingPanel";
import { WelcomeCard } from "./WelcomeCard";
import {
  WhiteboardCanvas,
  type WhiteboardCanvasHandle,
} from "./WhiteboardCanvas";
import {
  EMPTY_BOARD_SNAPSHOT,
  type BoardElement,
  type BoardImageElement,
  type BoardMediaElement,
  type BoardSnapshot,
  type BoardStrokeElement,
  type BoardTool,
  type BoardViewport,
  type WhiteboardStrokeEvent,
} from "../../lib/board-types";
import {
  DeviceLink,
  type DeviceLinkEnvelope,
  type DeviceLinkState,
} from "../../lib/device-link";
import {
  deleteAsset,
  downloadJsonFile,
  listAssets,
  loadBoard,
  putAsset,
  readJsonFile,
  requestDurableLocalStorage,
  saveBoard,
  type StoredAsset,
} from "../../lib/local-board-store";
import { createLinkAsset, createStoredAsset } from "../../lib/media-utils";

const BOARD_ID = "canvasroom-home";
const DEFAULT_TITLE = "Untitled board";
const COLORS = ["#171b19", "#5470ff", "#ff7655", "#d09c16", "#238261"];

type ActivePanel = "media" | "device" | "record" | null;
type SaveState = "loading" | "saving" | "saved" | "error";

const IDLE_DEVICE_STATE: DeviceLinkState = {
  role: null,
  phase: "idle",
  transport: null,
  pairingCode: null,
  sessionId: null,
  joinUrl: null,
  inviteToken: null,
  answerToken: null,
  peerLabel: null,
  statusMessage: null,
  error: null,
};

const tools: Array<{ id: BoardTool; label: string; key: string; icon: typeof PenTool }> = [
  { id: "select", label: "Select", key: "V", icon: MousePointer2 },
  { id: "pan", label: "Pan", key: "H", icon: Hand },
  { id: "pen", label: "Pen", key: "P", icon: PenTool },
  { id: "highlighter", label: "Highlighter", key: "M", icon: Highlighter },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { id: "line", label: "Line", key: "L", icon: Minus },
  { id: "rectangle", label: "Rectangle", key: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { id: "arrow", label: "Arrow", key: "A", icon: ArrowUpRight },
  { id: "text", label: "Text", key: "T", icon: Type },
];

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isBoardSnapshot(value: unknown): value is BoardSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<BoardSnapshot>;
  return typeof snapshot.version === "number" && Array.isArray(snapshot.elements);
}

function panelButtonClass(panel: ActivePanel, active: ActivePanel) {
  return `topbar-button${panel === active ? " is-active" : ""}`;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function WhiteboardApp() {
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  const remoteStrokesRef = useRef(new Map<string, BoardStrokeElement>());
  const snapshotRef = useRef<BoardSnapshot>(EMPTY_BOARD_SNAPSHOT);

  const [deviceLink] = useState(() => new DeviceLink({ deviceLabel: "CanvasRoom desktop" }));
  const [deviceState, setDeviceState] = useState<DeviceLinkState>(IDLE_DEVICE_STATE);
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(EMPTY_BOARD_SNAPSHOT);
  const [viewport, setViewport] = useState<BoardViewport>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState<BoardTool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(3.5);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [assets, setAssets] = useState<StoredAsset[]>([]);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [showWelcome, setShowWelcome] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [online, setOnline] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [recording, setRecording] = useState(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3_000);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([loadBoard<BoardSnapshot>(BOARD_ID), listAssets(BOARD_ID), requestDurableLocalStorage()])
      .then(([storedBoard, storedAssets]) => {
        if (!active) return;
        if (storedBoard && isBoardSnapshot(storedBoard.snapshot)) {
          setSnapshot(storedBoard.snapshot);
          setTitle(storedBoard.title || DEFAULT_TITLE);
        }
        setAssets(storedAssets);
        const arrivingFromInvite = window.location.search.includes("device-link=") || window.location.search.includes("pair=");
        if (arrivingFromInvite) setActivePanel("device");
        else setShowWelcome(!storedBoard?.snapshot || storedBoard.snapshot.elements.length === 0);
        loadedRef.current = true;
        setSaveState("saved");
      })
      .catch((error) => {
        if (!active) return;
        loadedRef.current = true;
        setSaveState("error");
        setShowWelcome(true);
        showToast(error instanceof Error ? error.message : "Local storage could not be opened.");
      });

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      active = false;
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [showToast]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveState("saving");
    saveTimerRef.current = setTimeout(() => {
      const now = new Date().toISOString();
      void saveBoard<BoardSnapshot>({
        id: BOARD_ID,
        title: title.trim() || DEFAULT_TITLE,
        snapshot,
        createdAt: now,
        updatedAt: now,
      }).then(() => setSaveState("saved")).catch(() => setSaveState("error"));
    }, 420);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [snapshot, title]);

  useEffect(() => () => deviceLink.close(), [deviceLink]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (deviceState.phase !== "connected") return;
    const current = snapshotRef.current;
    deviceLink.send({ type: "board:snapshot", revision: current.version, snapshot: current });
  }, [deviceLink, deviceState.phase]); // Send once when the connection becomes ready.

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const pressed = event.key.toUpperCase();
      const requested = tools.find((item) => item.key === pressed);
      if (requested) setTool(requested.id);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onCanvasChange = useCallback((next: BoardSnapshot) => {
    setSnapshot(next);
    setShowWelcome(false);
    if (deviceLink.getState().phase === "connected") {
      deviceLink.send({ type: "board:snapshot", revision: next.version, snapshot: next });
    }
  }, [deviceLink]);

  const onStrokeEvent = useCallback((event: WhiteboardStrokeEvent) => {
    if (deviceLink.getState().phase !== "connected") return;
    if (event.type === "begin") {
      deviceLink.send({
        type: "stroke:begin",
        strokeId: event.stroke.id,
        point: event.firstPoint,
        tool: event.stroke.tool,
        color: event.stroke.color,
        width: event.stroke.width,
      });
    } else if (event.type === "points") {
      deviceLink.send({
        type: "stroke:points",
        strokeId: event.strokeId,
        points: event.points,
        sequence: event.sequence,
      });
    } else if (event.type === "end") {
      deviceLink.send({
        type: "stroke:end",
        strokeId: event.stroke.id,
        point: event.stroke.points[event.stroke.points.length - 1],
        sequence: event.sequence,
      });
    } else {
      deviceLink.send({ type: "stroke:cancel", strokeId: event.strokeId });
    }
  }, [deviceLink]);

  const onDeviceMessage = useCallback((message: DeviceLinkEnvelope) => {
    const payload = message.payload;
    if (payload.type === "board:request-snapshot") {
      deviceLink.send({ type: "board:snapshot", revision: snapshot.version, snapshot });
      return;
    }
    if (payload.type === "board:snapshot" && isBoardSnapshot(payload.snapshot)) {
      remoteStrokesRef.current.clear();
      setSnapshot(payload.snapshot);
      setShowWelcome(false);
      return;
    }
    if (payload.type === "stroke:begin") {
      const stroke: BoardStrokeElement = {
        id: payload.strokeId,
        type: "stroke",
        tool: payload.tool === "highlighter" ? "highlighter" : "pen",
        color: payload.color ?? "#171b19",
        width: payload.width ?? 3.5,
        points: [{ pressure: 0.5, time: performance.now(), ...payload.point }],
        createdAt: Date.now(),
      };
      remoteStrokesRef.current.set(payload.strokeId, stroke);
      setSnapshot((current) => ({
        version: current.version + 1,
        elements: [...current.elements.filter((element) => element.id !== payload.strokeId), stroke],
      }));
      setShowWelcome(false);
      return;
    }
    if (payload.type === "stroke:points") {
      const stroke = remoteStrokesRef.current.get(payload.strokeId);
      if (!stroke) return;
      const updated: BoardStrokeElement = {
        ...stroke,
        points: [
          ...stroke.points,
          ...payload.points.map((point) => ({ pressure: 0.5, time: performance.now(), ...point })),
        ],
      };
      remoteStrokesRef.current.set(payload.strokeId, updated);
      setSnapshot((current) => ({
        version: current.version + 1,
        elements: current.elements.map((element) => element.id === payload.strokeId ? updated : element),
      }));
      return;
    }
    if (payload.type === "stroke:end") {
      remoteStrokesRef.current.delete(payload.strokeId);
      return;
    }
    if (payload.type === "stroke:cancel") {
      remoteStrokesRef.current.delete(payload.strokeId);
      setSnapshot((current) => ({
        version: current.version + 1,
        elements: current.elements.filter((element) => element.id !== payload.strokeId),
      }));
    }
  }, [deviceLink, snapshot]);

  const uploadFiles = useCallback(async (files: File[]) => {
    const created: StoredAsset[] = [];
    for (const file of files) {
      const asset = await createStoredAsset(BOARD_ID, file);
      await putAsset(asset);
      created.push(asset);
    }
    setAssets((current) => [...created, ...current]);
    showToast(`${created.length} ${created.length === 1 ? "attachment" : "attachments"} added locally.`);
  }, [showToast]);

  const addLink = useCallback(async (url: string) => {
    const asset = createLinkAsset(BOARD_ID, url);
    await putAsset(asset);
    setAssets((current) => [asset, ...current]);
    showToast("Link added to the media library.");
  }, [showToast]);

  const boardCenter = useCallback(() => {
    const stage = stageRef.current;
    const currentViewport = canvasRef.current?.getViewport() ?? viewport;
    return {
      x: ((stage?.clientWidth ?? 900) / 2 - currentViewport.x) / currentViewport.zoom,
      y: ((stage?.clientHeight ?? 600) / 2 - currentViewport.y) / currentViewport.zoom,
    };
  }, [viewport]);

  const placeAsset = useCallback((asset: StoredAsset) => {
    const center = boardCenter();
    let element: BoardElement;
    if (asset.kind === "image" && asset.preview) {
      element = {
        id: createId("image"),
        type: "image",
        x: center.x - 160,
        y: center.y - 105,
        width: 320,
        height: 210,
        sourceUrl: asset.preview,
        alt: asset.name,
        assetId: asset.id,
        createdAt: Date.now(),
      } satisfies BoardImageElement;
    } else {
      element = {
        id: createId("media"),
        type: "media",
        kind: asset.kind,
        x: center.x - 150,
        y: center.y - 42,
        width: 300,
        height: 84,
        title: asset.name,
        href: asset.sourceUrl,
        sourceUrl: asset.sourceUrl,
        thumbnailUrl: asset.preview,
        mimeType: asset.mimeType,
        assetId: asset.id,
        createdAt: Date.now(),
      } satisfies BoardMediaElement;
    }
    canvasRef.current?.addElements([element]);
    setActivePanel(null);
    showToast(`${asset.name} placed on the board.`);
  }, [boardCenter, showToast]);

  const removeAsset = useCallback((asset: StoredAsset) => {
    void deleteAsset(asset.id).then(() => {
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      showToast(`${asset.name} removed from the library.`);
    });
  }, [showToast]);

  const exportPng = useCallback(() => {
    const image = canvasRef.current?.exportViewportPng();
    if (!image) {
      showToast("This board contains media that cannot be included in a PNG export.");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = image;
    anchor.download = `${(title.trim() || "canvasroom-board").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
    anchor.click();
    showToast("Board image exported.");
  }, [showToast, title]);

  const exportBoard = useCallback(() => {
    const portableAssets = assets.map((asset) => {
      const portable: Omit<StoredAsset, "blob"> & { blob?: never } = { ...asset, blob: undefined };
      delete portable.blob;
      return portable;
    });
    downloadJsonFile({
      format: "canvasroom-board",
      schemaVersion: 1,
      board: { id: BOARD_ID, title, snapshot },
      assets: portableAssets,
      exportedAt: new Date().toISOString(),
    }, `${(title.trim() || "canvasroom-board").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.canvasroom.json`);
    showToast("Portable board file saved.");
  }, [assets, showToast, snapshot, title]);

  const importBoard = useCallback(async (file: File) => {
    type PortableBoard = { format?: string; board?: { title?: string; snapshot?: unknown } };
    const imported = await readJsonFile<PortableBoard>(file);
    if (imported.format !== "canvasroom-board" || !isBoardSnapshot(imported.board?.snapshot)) {
      throw new Error("That file is not a CanvasRoom board.");
    }
    setTitle(imported.board?.title?.trim() || DEFAULT_TITLE);
    setSnapshot(imported.board.snapshot);
    setShowWelcome(false);
    showToast("Board imported and saved locally.");
  }, [showToast]);

  const togglePanel = useCallback((panel: Exclude<ActivePanel, null>) => {
    setShowWelcome(false);
    setActivePanel((current) => current === panel ? null : panel);
  }, []);

  const getSourceCanvas = useCallback(() => stageRef.current?.querySelector("canvas") ?? null, []);

  const toolSettingsVisible = tool === "pen" || tool === "highlighter" || tool === "line" || tool === "rectangle" || tool === "ellipse" || tool === "arrow";
  const saveLabel = saveState === "loading" ? "Opening local board…" : saveState === "saving" ? "Saving locally…" : saveState === "error" ? "Local save needs attention" : "Saved on this device";
  const deviceConnected = deviceState.phase === "connected";

  const toolbar = useMemo(() => tools.map((item) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        className={`tool-button${tool === item.id ? " is-active" : ""}`}
        onClick={() => { setTool(item.id); setShowWelcome(false); }}
        title={`${item.label} (${item.key})`}
        aria-label={`${item.label} tool`}
        aria-pressed={tool === item.id}
      >
        <Icon size={17} strokeWidth={1.9} />
        <span className="tool-key">{item.key}</span>
      </button>
    );
  }), [tool]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand" aria-label="CanvasRoom">
            <span className="brand-mark"><PenTool size={14} strokeWidth={2.4} /></span>
            <span className="brand-name">CanvasRoom</span>
          </div>
          <div className="board-title-wrap">
            <input
              className="board-title-input"
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => { if (!title.trim()) setTitle(DEFAULT_TITLE); }}
              aria-label="Board title"
            />
            <span className="save-state">{saveLabel}</span>
          </div>
        </div>

        <div className="topbar-center">
          <span className="presence">
            <span className="presence-dot" />
            {deviceConnected ? "iPad connected" : online ? "Local workspace ready" : "Working offline"}
          </span>
        </div>

        <div className="topbar-actions">
          <button className={panelButtonClass("device", activePanel)} onClick={() => togglePanel("device")}>
            <TabletSmartphone size={15} /><span className="button-label">{deviceConnected ? "Connected" : "Connect"}</span>
          </button>
          <button className={panelButtonClass("media", activePanel)} onClick={() => togglePanel("media")}>
            <ImageIcon size={15} /><span className="button-label">Media</span>
          </button>
          <button className={`${panelButtonClass("record", activePanel)} record-button${recording ? " is-recording" : ""}`} onClick={() => togglePanel("record")}>
            <span className="record-dot" /><span className="button-label">{recording ? "Recording" : "Record"}</span>
          </button>
          <button className="topbar-button" onClick={exportBoard} title="Save portable board file">
            <Save size={15} /><span className="button-label">Save file</span>
          </button>
          <button className="topbar-button" onClick={() => importInputRef.current?.click()} title="Open a portable CanvasRoom board">
            <Upload size={15} /><span className="button-label">Open</span>
          </button>
          <button className="topbar-button" onClick={exportPng} title="Export current view as PNG">
            <Download size={15} /><span className="button-label">Export</span>
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="tool-rail" aria-label="Whiteboard tools">
          <div className="toolbar-group">{toolbar.slice(0, 5)}</div>
          <span className="toolbar-separator" />
          <div className="toolbar-group">{toolbar.slice(5)}</div>
          <div className="toolbar-spacer" />
          <div className="toolbar-group">
            <button className="tool-button" onClick={() => canvasRef.current?.undo()} disabled={!canUndo} aria-label="Undo" title="Undo (Command Z)"><Undo2 size={17} /></button>
            <button className="tool-button" onClick={() => canvasRef.current?.redo()} disabled={!canRedo} aria-label="Redo" title="Redo"><Redo2 size={17} /></button>
          </div>
        </nav>

        <section
          ref={stageRef}
          className={`canvas-stage${draggingFiles ? " is-dragging" : ""}`}
          aria-label="Whiteboard workspace"
          onDragEnter={(event: DragEvent) => { event.preventDefault(); setDraggingFiles(true); }}
          onDragOver={(event: DragEvent) => event.preventDefault()}
          onDragLeave={(event: DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDraggingFiles(false);
            if (event.dataTransfer.files.length) void uploadFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <WhiteboardCanvas
            ref={canvasRef}
            className="board-canvas"
            snapshot={snapshot}
            tool={tool}
            color={color}
            strokeWidth={strokeWidth}
            viewport={viewport}
            onViewportChange={setViewport}
            onSnapshotChange={onCanvasChange}
            onStrokeEvent={onStrokeEvent}
            onHistoryChange={({ canUndo: undo, canRedo: redo }) => { setCanUndo(undo); setCanRedo(redo); }}
            allowFingerDrawing={false}
            showGrid
            gridSize={22}
            backgroundColor="#f7f5ee"
            ariaLabel="CanvasRoom whiteboard"
          />

          {showWelcome ? <WelcomeCard onStart={() => { setShowWelcome(false); setTool("pen"); canvasRef.current?.focus(); }} onConnect={() => { setShowWelcome(false); setActivePanel("device"); }} /> : null}

          {toolSettingsVisible ? (
            <div className="floating-tool-settings" aria-label="Tool settings">
              <span className="setting-label">Ink</span>
              <div className="color-swatches">
                {COLORS.map((value) => (
                  <button
                    key={value}
                    className={`color-swatch${color === value ? " is-active" : ""}`}
                    style={{ "--swatch": value } as React.CSSProperties}
                    onClick={() => setColor(value)}
                    aria-label={`Use ${value} ink`}
                    aria-pressed={color === value}
                  />
                ))}
              </div>
              <span className="setting-label">Size</span>
              <input className="size-slider" type="range" min="1" max="18" step="0.5" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} aria-label="Stroke width" />
            </div>
          ) : null}

          <div className="board-status">
            <span className="status-item">{online ? <Wifi size={13} /> : <WifiOff size={13} />} {online ? "Ready" : "Offline"}</span>
            <span className="status-item">{snapshot.elements.length} {snapshot.elements.length === 1 ? "object" : "objects"}</span>
            <div className="status-item zoom-controls" aria-label="Zoom controls">
              <button onClick={() => setViewport((current) => ({ ...current, zoom: Math.max(0.15, current.zoom / 1.2) }))} aria-label="Zoom out"><ZoomOut size={14} /></button>
              <span className="zoom-label">{Math.round(viewport.zoom * 100)}%</span>
              <button onClick={() => setViewport((current) => ({ ...current, zoom: Math.min(8, current.zoom * 1.2) }))} aria-label="Zoom in"><ZoomIn size={14} /></button>
              <button onClick={() => canvasRef.current?.fitToContent()} aria-label="Fit board to content"><Maximize2 size={14} /></button>
            </div>
          </div>

          <MediaLibrary
            open={activePanel === "media"}
            assets={assets}
            onClose={() => setActivePanel(null)}
            onUpload={uploadFiles}
            onAddLink={addLink}
            onPlace={placeAsset}
            onDelete={removeAsset}
          />

          {activePanel === "device" ? (
            <div className="side-panel" style={{ padding: 0, background: "transparent", border: 0, boxShadow: "none", overflow: "auto" }}>
              <DeviceLinkPanel
                deviceLink={deviceLink}
                onMessage={onDeviceMessage}
                onStateChange={setDeviceState}
                onClose={() => setActivePanel(null)}
              />
            </div>
          ) : null}

          {activePanel === "record" ? (
            <aside className="side-panel" aria-label="Recording controls">
              <div className="panel-heading">
                <div><span className="eyebrow">Capture this explanation</span><h2>Recording studio</h2></div>
                <button className="icon-button" onClick={() => setActivePanel(null)} aria-label="Close recording panel"><X size={18} /></button>
              </div>
              <RecordingPanel
                getSourceCanvas={getSourceCanvas}
                onStatusChange={(status) => setRecording(status === "recording" || status === "paused" || status === "preparing" || status === "stopping")}
                onRecordingSaved={(_result, save) => showToast(`Recording saved as ${save.fileName}.`)}
                onError={(error) => showToast(error.message)}
              />
            </aside>
          ) : null}

          {draggingFiles ? <div className="canvas-corner-hint"><strong>Drop to attach</strong>These files will stay on this device.</div> : null}
        </section>
      </div>

      <input
        ref={importInputRef}
        type="file"
        className="visually-hidden"
        accept=".json,.canvasroom.json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importBoard(file).catch((error) => showToast(error instanceof Error ? error.message : "Import failed."));
          event.target.value = "";
        }}
      />

      {toast ? <div className="toast-stack"><div className="toast" role="status"><Link2 size={15} />{toast}</div></div> : null}
    </main>
  );
}
