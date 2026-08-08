"use client";

import {
  ArrowUpRight,
  Circle,
  Download,
  Eraser,
  FileCheck2,
  FolderOpen,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  PenTool,
  Plus,
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
  CANVASROOM_BOARD_ACCEPT,
  createCanvasRoomDocument,
  createCanvasRoomFileName,
  readCanvasRoomFile,
  restoreCanvasRoomAssets,
  saveCanvasRoomDocument,
  summarizeCanvasRoomDocument,
  type CanvasRoomBoardDocument,
} from "../../lib/board-file";
import {
  deleteAsset,
  listAssets,
  listBoards,
  putAsset,
  requestDurableLocalStorage,
  saveBoard,
  type StoredAsset,
  type StoredBoard,
} from "../../lib/local-board-store";
import { createLinkAsset, createStoredAsset } from "../../lib/media-utils";

const DEFAULT_BOARD_ID = "canvasroom-home";
const DEFAULT_TITLE = "Untitled board";
const COLORS = ["#171b19", "#5470ff", "#ff7655", "#d09c16", "#238261"];

type ActivePanel = "media" | "device" | "open" | null;
type SaveState = "loading" | "saving" | "saved" | "error";
type BoardFileCandidate = { file: File; document: CanvasRoomBoardDocument };
type BoardTab = Omit<StoredBoard<BoardSnapshot>, "viewport"> & { viewport: BoardViewport };

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

function formatBoardDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Legacy board" : date.toLocaleString();
}

export function WhiteboardApp() {
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetLoadSequenceRef = useRef(0);
  const activeBoardCreatedAtRef = useRef(new Date().toISOString());
  const loadedRef = useRef(false);
  const remoteStrokesRef = useRef(new Map<string, BoardStrokeElement>());
  const snapshotRef = useRef<BoardSnapshot>(EMPTY_BOARD_SNAPSHOT);

  const [deviceLink] = useState(() => new DeviceLink({ deviceLabel: "CanvasRoom desktop" }));
  const [deviceState, setDeviceState] = useState<DeviceLinkState>(IDLE_DEVICE_STATE);
  const [activeBoardId, setActiveBoardId] = useState(DEFAULT_BOARD_ID);
  const [boardTabs, setBoardTabs] = useState<BoardTab[]>([]);
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
  const [recordPanelOpen, setRecordPanelOpen] = useState(false);
  const [boardFileCandidate, setBoardFileCandidate] = useState<BoardFileCandidate | null>(null);
  const [boardFileBusy, setBoardFileBusy] = useState(false);
  const [boardFileError, setBoardFileError] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3_000);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([listBoards<BoardSnapshot>(), requestDurableLocalStorage()])
      .then(async ([storedBoards]) => {
        if (!active) return;
        const now = new Date().toISOString();
        const tabs: BoardTab[] = storedBoards
          .filter((board) => isBoardSnapshot(board.snapshot))
          .map((board) => ({
            ...board,
            title: board.title?.trim() || DEFAULT_TITLE,
            viewport: board.viewport ?? { x: 0, y: 0, zoom: 1 },
          }));
        const initial = tabs[0] ?? {
          id: DEFAULT_BOARD_ID,
          title: DEFAULT_TITLE,
          snapshot: { version: 0, elements: [] },
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAt: now,
          updatedAt: now,
        } satisfies BoardTab;
        if (tabs.length === 0) tabs.push(initial);
        const storedAssets = await listAssets(initial.id);
        if (!active) return;
        setBoardTabs(tabs);
        activeBoardCreatedAtRef.current = initial.createdAt;
        setActiveBoardId(initial.id);
        setSnapshot(initial.snapshot);
        setViewport(initial.viewport);
        setTitle(initial.title);
        setAssets(storedAssets);
        const arrivingFromInvite = window.location.search.includes("device-link=") || window.location.search.includes("pair=");
        if (arrivingFromInvite) setActivePanel("device");
        else setShowWelcome(initial.snapshot.elements.length === 0);
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
      const serviceWorkerUrl = new URL("sw.js", document.baseURI).toString();
      void navigator.serviceWorker.register(serviceWorkerUrl).catch(() => undefined);
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
      const savedTitle = title.trim() || DEFAULT_TITLE;
      setBoardTabs((current) => current.map((tab) => tab.id === activeBoardId ? {
        ...tab,
        title: savedTitle,
        snapshot,
        viewport,
        updatedAt: now,
      } : tab));
      void saveBoard<BoardSnapshot>({
        id: activeBoardId,
        title: savedTitle,
        snapshot,
        viewport,
        createdAt: activeBoardCreatedAtRef.current || now,
        updatedAt: now,
      }).then(() => setSaveState("saved")).catch(() => setSaveState("error"));
    }, 420);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeBoardId, snapshot, title, viewport]);

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

  const loadAssetsForBoard = useCallback(async (boardId: string) => {
    const sequence = ++assetLoadSequenceRef.current;
    setAssets([]);
    try {
      const nextAssets = await listAssets(boardId);
      if (sequence === assetLoadSequenceRef.current) setAssets(nextAssets);
    } catch (error) {
      if (sequence === assetLoadSequenceRef.current) {
        showToast(error instanceof Error ? error.message : "This board's attachments could not be opened.");
      }
    }
  }, [showToast]);

  const persistCurrentBoard = useCallback(() => {
    const now = new Date().toISOString();
    return saveBoard<BoardSnapshot>({
      id: activeBoardId,
      title: title.trim() || DEFAULT_TITLE,
      snapshot,
      viewport,
      createdAt: activeBoardCreatedAtRef.current || now,
      updatedAt: now,
    });
  }, [activeBoardId, snapshot, title, viewport]);

  const switchBoardTab = useCallback((boardId: string) => {
    if (boardId === activeBoardId) return;
    const next = boardTabs.find((tab) => tab.id === boardId);
    if (!next) return;
    void persistCurrentBoard().catch(() => setSaveState("error"));
    const now = new Date().toISOString();
    setBoardTabs((current) => current.map((tab) => tab.id === activeBoardId ? {
      ...tab,
      title: title.trim() || DEFAULT_TITLE,
      snapshot,
      viewport,
      updatedAt: now,
    } : tab));
    activeBoardCreatedAtRef.current = next.createdAt;
    setActiveBoardId(next.id);
    setTitle(next.title);
    setSnapshot(next.snapshot);
    setViewport(next.viewport);
    setShowWelcome(next.snapshot.elements.length === 0);
    if (!recording) setActivePanel(null);
    void loadAssetsForBoard(next.id);
  }, [activeBoardId, boardTabs, loadAssetsForBoard, persistCurrentBoard, recording, snapshot, title, viewport]);

  const createBoardTab = useCallback(() => {
    const now = new Date().toISOString();
    const tab: BoardTab = {
      id: createId("board"),
      title: `Lecture ${boardTabs.length + 1}`,
      snapshot: { version: 0, elements: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    };
    void persistCurrentBoard().catch(() => setSaveState("error"));
    setBoardTabs((current) => [
      ...current.map((item) => item.id === activeBoardId ? {
        ...item,
        title: title.trim() || DEFAULT_TITLE,
        snapshot,
        viewport,
        updatedAt: now,
      } : item),
      tab,
    ]);
    activeBoardCreatedAtRef.current = tab.createdAt;
    setActiveBoardId(tab.id);
    setTitle(tab.title);
    setSnapshot(tab.snapshot);
    setViewport(tab.viewport);
    assetLoadSequenceRef.current += 1;
    setAssets([]);
    setShowWelcome(true);
    if (!recording) setActivePanel(null);
  }, [activeBoardId, boardTabs.length, persistCurrentBoard, recording, snapshot, title, viewport]);

  const onCanvasChange = useCallback((next: BoardSnapshot) => {
    setSnapshot(next);
    setBoardTabs((current) => current.map((tab) => tab.id === activeBoardId ? {
      ...tab,
      snapshot: next,
      updatedAt: new Date().toISOString(),
    } : tab));
    setShowWelcome(false);
    if (deviceLink.getState().phase === "connected") {
      deviceLink.send({ type: "board:snapshot", revision: next.version, snapshot: next });
    }
  }, [activeBoardId, deviceLink]);

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
      const asset = await createStoredAsset(activeBoardId, file);
      await putAsset(asset);
      created.push(asset);
    }
    setAssets((current) => [...created, ...current]);
    showToast(`${created.length} ${created.length === 1 ? "attachment" : "attachments"} added locally.`);
  }, [activeBoardId, showToast]);

  const addLink = useCallback(async (url: string) => {
    const asset = createLinkAsset(activeBoardId, url);
    await putAsset(asset);
    setAssets((current) => [asset, ...current]);
    showToast("Link added to the media library.");
  }, [activeBoardId, showToast]);

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

  const exportBoard = useCallback(async () => {
    if (boardFileBusy) return;
    setBoardFileBusy(true);
    setBoardFileError(null);
    try {
      const document = await createCanvasRoomDocument({ title, snapshot, viewport, assets });
      const result = await saveCanvasRoomDocument(document, createCanvasRoomFileName(title));
      if (result === "cancelled") {
        showToast("Board export cancelled.");
      } else {
        showToast(`CanvasRoom board saved with ${assets.length} ${assets.length === 1 ? "attachment" : "attachments"}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The board file could not be saved.";
      setBoardFileError(message);
      showToast(message);
    } finally {
      setBoardFileBusy(false);
    }
  }, [assets, boardFileBusy, showToast, snapshot, title, viewport]);

  const inspectBoardFile = useCallback(async (file: File) => {
    setBoardFileBusy(true);
    setBoardFileError(null);
    setBoardFileCandidate(null);
    try {
      const document = await readCanvasRoomFile(file);
      setBoardFileCandidate({ file, document });
    } catch (error) {
      setBoardFileError(error instanceof Error ? error.message : "That board file could not be read.");
    } finally {
      setBoardFileBusy(false);
    }
  }, []);

  const openBoardCandidate = useCallback(async () => {
    if (!boardFileCandidate || boardFileBusy) return;
    setBoardFileBusy(true);
    setBoardFileError(null);
    try {
      const importedAssets = await restoreCanvasRoomAssets(boardFileCandidate.document.assets, activeBoardId);
      assetLoadSequenceRef.current += 1;
      await Promise.all(importedAssets.map(putAsset));
      const importedIds = new Set(importedAssets.map((asset) => asset.id));
      await Promise.all(assets.filter((asset) => !importedIds.has(asset.id)).map((asset) => deleteAsset(asset.id)));
      setAssets(importedAssets);
      setTitle(boardFileCandidate.document.board.title || DEFAULT_TITLE);
      setSnapshot(boardFileCandidate.document.board.snapshot);
      setViewport(boardFileCandidate.document.board.viewport);
      setShowWelcome(false);
      setActivePanel(null);
      setBoardFileCandidate(null);
      showToast(`Opened ${boardFileCandidate.file.name}.`);
    } catch (error) {
      setBoardFileError(error instanceof Error ? error.message : "That board could not be opened.");
    } finally {
      setBoardFileBusy(false);
    }
  }, [activeBoardId, assets, boardFileBusy, boardFileCandidate, showToast]);

  const togglePanel = useCallback((panel: Exclude<ActivePanel, null>) => {
    setShowWelcome(false);
    if (!recording) setRecordPanelOpen(false);
    setActivePanel((current) => current === panel ? null : panel);
  }, [recording]);

  const boardFileSummary = useMemo(
    () => boardFileCandidate ? summarizeCanvasRoomDocument(boardFileCandidate.document) : null,
    [boardFileCandidate],
  );
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
          <button
            className={`topbar-button${recordPanelOpen ? " is-active" : ""} record-button${recording ? " is-recording" : ""}`}
            onClick={() => {
              if (recording) return;
              setShowWelcome(false);
              setActivePanel(null);
              setRecordPanelOpen((current) => !current);
            }}
          >
            <span className="record-dot" /><span className="button-label">{recording ? "Recording" : "Record"}</span>
          </button>
          <button className="topbar-button" disabled={boardFileBusy} onClick={() => void exportBoard()} title="Export a complete CanvasRoom board file">
            <Save size={15} /><span className="button-label">Board file</span>
          </button>
          <button className={panelButtonClass("open", activePanel)} onClick={() => togglePanel("open")} title="Open a CanvasRoom board">
            <FolderOpen size={15} /><span className="button-label">Open</span>
          </button>
          <button className="topbar-button" onClick={exportPng} title="Export current view as PNG">
            <Download size={15} /><span className="button-label">PNG</span>
          </button>
        </div>
      </header>

      <nav className="board-tabs" aria-label="Lecture boards">
        <div className="board-tab-scroll" role="tablist" aria-label="Open lecture boards">
          {boardTabs.map((tab, index) => {
            const active = tab.id === activeBoardId;
            const tabTitle = active ? title.trim() || DEFAULT_TITLE : tab.title;
            return (
              <button
                key={tab.id}
                aria-controls="active-whiteboard"
                aria-selected={active}
                className={`board-tab${active ? " is-active" : ""}`}
                onClick={() => switchBoardTab(tab.id)}
                role="tab"
                type="button"
              >
                <span className="board-tab-index">{index + 1}</span>
                <span className="board-tab-title">{tabTitle}</span>
                <span className="board-tab-count">{tab.snapshot.elements.length}</span>
              </button>
            );
          })}
        </div>
        <button className="board-tab-add" onClick={createBoardTab} type="button" title="Add lecture board" aria-label="Add lecture board">
          <Plus size={14} /> <span>New lecture</span>
        </button>
      </nav>

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
          id="active-whiteboard"
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
            documentId={activeBoardId}
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

          {activePanel === "open" ? (
            <aside className="side-panel" aria-label="Open CanvasRoom board">
              <div className="panel-heading">
                <div><span className="eyebrow">Board-native document</span><h2>Open board</h2></div>
                <button className="icon-button" onClick={() => setActivePanel(null)} aria-label="Close open board panel"><X size={18} /></button>
              </div>

              <p className="board-file-intro">
                Choose a <strong>.canvasroom</strong> file. CanvasRoom will inspect it first, then let you confirm before replacing this board.
              </p>

              <button
                className="board-file-picker"
                disabled={boardFileBusy}
                onClick={() => importInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const file = event.dataTransfer.files[0];
                  if (file) void inspectBoardFile(file);
                }}
                type="button"
              >
                <span className="board-file-picker-icon"><Upload size={20} /></span>
                <span><strong>{boardFileBusy ? "Reading board…" : "Choose a board file"}</strong><small>or drop it here · .canvasroom and legacy JSON</small></span>
              </button>

              {boardFileCandidate && boardFileSummary ? (
                <div className="board-file-selection" aria-live="polite">
                  <span className="board-file-selection-icon"><FileCheck2 size={19} /></span>
                  <div>
                    <strong>{boardFileSummary.title}</strong>
                    <span>{boardFileCandidate.file.name}</span>
                    <small>
                      {boardFileSummary.objectCount} {boardFileSummary.objectCount === 1 ? "object" : "objects"} · {boardFileSummary.attachmentCount} {boardFileSummary.attachmentCount === 1 ? "attachment" : "attachments"}
                    </small>
                    <small>{formatBoardDate(boardFileSummary.exportedAt)}</small>
                  </div>
                </div>
              ) : null}

              {boardFileError ? <p className="board-file-error" role="alert">{boardFileError}</p> : null}

              <div className="board-file-actions">
                <button className="secondary-button" onClick={() => setActivePanel(null)} type="button">Cancel</button>
                <button className="primary-button" disabled={!boardFileCandidate || boardFileBusy} onClick={() => void openBoardCandidate()} type="button">
                  <FolderOpen size={15} /> Open this board
                </button>
              </div>
              <p className="board-file-footnote">Your current board stays untouched until you confirm. It is already saved locally on this device.</p>
            </aside>
          ) : null}

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

          {recordPanelOpen ? (
            <aside className={`side-panel recording-panel-shell${recording ? " is-active" : ""}`} aria-label="Recording controls">
              <div className="panel-heading">
                <div><span className="eyebrow">Capture this explanation</span><h2>Recording studio</h2></div>
                <button className="icon-button" onClick={() => setRecordPanelOpen(false)} aria-label="Close recording panel"><X size={18} /></button>
              </div>
              <RecordingPanel
                captureMode="screen"
                className="recording-panel-content"
                onStatusChange={(status) => {
                  if (status === "recording" || status === "paused" || status === "stopping") setRecording(true);
                  else if (status !== "idle") setRecording(false);
                }}
                onRecordingSaved={(_result, save) => {
                  setRecording(false);
                  showToast(`Recording saved as ${save.fileName}.`);
                }}
                onRecordingDiscarded={() => {
                  setRecording(false);
                  showToast("Recording discarded. Nothing was saved.");
                }}
                onError={(error) => {
                  setRecording(false);
                  showToast(error.message);
                }}
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
        accept={CANVASROOM_BOARD_ACCEPT}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void inspectBoardFile(file);
          event.target.value = "";
        }}
      />

      {toast ? <div className="toast-stack"><div className="toast" role="status"><Link2 size={15} />{toast}</div></div> : null}
    </main>
  );
}
