"use client";

/* eslint-disable jsx-a11y/no-interactive-element-to-noninteractive-role -- `application` is the WAI-ARIA role for this keyboard-operated drawing surface. */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import {
  DEFAULT_BOARD_VIEWPORT,
  EMPTY_BOARD_SNAPSHOT,
  type BoardChangeMeta,
  type BoardChangeReason,
  type BoardElement,
  type BoardHistoryState,
  type BoardImageElement,
  type BoardMediaElement,
  type BoardPoint,
  type BoardShapeElement,
  type BoardSnapshot,
  type BoardStrokeElement,
  type BoardTextElement,
  type BoardTool,
  type BoardViewport,
  type ShapeTool,
  type WhiteboardStrokeEvent,
} from "@/lib/board-types";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  boundsIntersect,
  clamp,
  distance,
  getElementBounds,
  getElementsBounds,
  hitTestElement,
  inflateBounds,
  makePoint,
  normalizeBounds,
  screenToWorld,
  translateElement,
  worldToScreen,
  zoomViewportAt,
} from "@/lib/board-geometry";

export interface WhiteboardCanvasHandle {
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
  clearSelection: () => void;
  resetViewport: () => void;
  fitToContent: (padding?: number) => void;
  getSnapshot: () => BoardSnapshot;
  getViewport: () => BoardViewport;
  addElements: (elements: BoardElement[]) => void;
  /** Exports the currently visible canvas. Returns null if a remote image tainted it. */
  exportViewportPng: () => string | null;
  focus: () => void;
}

export interface WhiteboardCanvasProps {
  /** Stable document identity used to isolate undo/redo history between tabs. */
  documentId?: string;
  /** Supply this to make board contents controlled. */
  snapshot?: BoardSnapshot;
  initialSnapshot?: BoardSnapshot;
  onSnapshotChange?: (snapshot: BoardSnapshot, meta: BoardChangeMeta) => void;
  tool: BoardTool;
  color?: string;
  strokeWidth?: number;
  fillColor?: string;
  fontSize?: number;
  viewport?: BoardViewport;
  initialViewport?: BoardViewport;
  onViewportChange?: (viewport: BoardViewport) => void;
  selectedElementIds?: string[];
  onSelectionChange?: (elementIds: string[]) => void;
  onHistoryChange?: (history: BoardHistoryState) => void;
  /** Ordered live ink packets for WebRTC/WebSocket transport. */
  onStrokeEvent?: (event: WhiteboardStrokeEvent) => void;
  allowFingerDrawing?: boolean;
  disabled?: boolean;
  showGrid?: boolean;
  gridSize?: number;
  backgroundColor?: string;
  maxHistory?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

type ScreenPoint = { x: number; y: number };

type Interaction =
  | { kind: "draw"; pointerId: number; element: BoardStrokeElement; sequence: number }
  | { kind: "shape"; pointerId: number; element: BoardShapeElement }
  | { kind: "pan"; pointerId: number; last: ScreenPoint }
  | {
      kind: "move";
      pointerId: number;
      start: ScreenPoint;
      original: BoardElement[];
      moved: boolean;
    }
  | {
      kind: "resize";
      pointerId: number;
      start: ScreenPoint;
      original: BoardImageElement | BoardMediaElement;
      aspectRatio: number;
    }
  | {
      kind: "erase";
      pointerId: number;
      original: BoardElement[];
      elements: BoardElement[];
      changed: boolean;
    }
  | {
      kind: "marquee";
      pointerId: number;
      start: ScreenPoint;
      current: ScreenPoint;
      baseSelection: string[];
    };

interface PinchGesture {
  initialDistance: number;
  initialCenter: ScreenPoint;
  initialViewport: BoardViewport;
  worldAtCenter: ScreenPoint;
}

interface TextEditorState {
  world: ScreenPoint;
  value: string;
}

const EMPTY_SELECTION: string[] = [];

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function isShapeTool(tool: BoardTool): tool is ShapeTool {
  return tool === "line" || tool === "rectangle" || tool === "ellipse" || tool === "arrow";
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: BoardStrokeElement): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = (stroke.opacity ?? 1) * (stroke.tool === "highlighter" ? 0.3 : 1);
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    const pressureScale = stroke.tool === "highlighter" ? 1.35 : 0.32 + point.pressure * 0.88;
    ctx.beginPath();
    ctx.arc(point.x, point.y, (stroke.width * pressureScale) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    const pressure = (start.pressure + end.pressure) / 2;
    ctx.lineWidth =
      stroke.width * (stroke.tool === "highlighter" ? 1.35 : 0.32 + pressure * 0.88);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  start: BoardPoint,
  end: BoardPoint,
  width: number,
): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(10, width * 4.5);
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - Math.cos(angle - Math.PI / 6) * length, end.y - Math.sin(angle - Math.PI / 6) * length);
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - Math.cos(angle + Math.PI / 6) * length, end.y - Math.sin(angle + Math.PI / 6) * length);
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: BoardShapeElement): void {
  const bounds = normalizeBounds({
    x: shape.start.x,
    y: shape.start.y,
    width: shape.end.x - shape.start.x,
    height: shape.end.y - shape.start.y,
  });
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.fill ?? "transparent";
  ctx.lineWidth = shape.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = shape.opacity ?? 1;
  ctx.beginPath();
  switch (shape.type) {
    case "line":
    case "arrow":
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      break;
    case "rectangle":
      ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
      break;
    case "ellipse":
      ctx.ellipse(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        Math.max(0.01, bounds.width / 2),
        Math.max(0.01, bounds.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      break;
  }
  if (shape.fill) ctx.fill();
  ctx.stroke();
  if (shape.type === "arrow") drawArrowHead(ctx, shape.start, shape.end, shape.width);
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, element: BoardTextElement): void {
  ctx.save();
  ctx.globalAlpha = element.opacity ?? 1;
  ctx.fillStyle = element.color;
  ctx.font = `${element.fontSize}px ${element.fontFamily ?? "Inter, ui-sans-serif, system-ui, sans-serif"}`;
  ctx.textBaseline = "top";
  const lineHeight = element.fontSize * 1.25;
  element.text.split("\n").forEach((line, index) => {
    ctx.fillText(line || " ", element.x, element.y + index * lineHeight);
  });
  ctx.restore();
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function mediaIcon(kind: BoardMediaElement["kind"]): string {
  switch (kind) {
    case "video":
      return "▶";
    case "audio":
      return "♫";
    case "pdf":
      return "PDF";
    case "link":
      return "↗";
    case "image":
      return "▧";
    case "file":
      return "DOC";
  }
}

function drawMediaCard(ctx: CanvasRenderingContext2D, media: BoardMediaElement): void {
  ctx.save();
  ctx.globalAlpha = media.opacity ?? 1;
  roundedRect(ctx, media.x, media.y, media.width, media.height, 12);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#d8dde8";
  ctx.lineWidth = 1;
  ctx.stroke();

  const iconSize = Math.min(46, media.height - 24);
  roundedRect(ctx, media.x + 12, media.y + 12, iconSize, iconSize, 9);
  ctx.fillStyle = media.kind === "link" ? "#e9f2ff" : "#f0edff";
  ctx.fill();
  ctx.fillStyle = "#4f46e5";
  ctx.font = `600 ${Math.max(10, iconSize * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mediaIcon(media.kind), media.x + 12 + iconSize / 2, media.y + 12 + iconSize / 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#172033";
  ctx.font = "600 14px ui-sans-serif, system-ui, sans-serif";
  const available = Math.max(20, media.width - iconSize - 36);
  let title = media.title || "Untitled attachment";
  while (title.length > 1 && ctx.measureText(title).width > available) title = `${title.slice(0, -2)}…`;
  ctx.fillText(title, media.x + iconSize + 24, media.y + 15);
  ctx.fillStyle = "#697386";
  ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(media.kind.toUpperCase(), media.x + iconSize + 24, media.y + 37);
  ctx.restore();
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  selectedElements: BoardElement[],
  zoom: number,
): void {
  const bounds = getElementsBounds(selectedElements);
  if (!bounds) return;
  const padding = 5 / zoom;
  const expanded = inflateBounds(bounds, padding);
  ctx.save();
  ctx.strokeStyle = "#635bff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  ctx.strokeRect(expanded.x, expanded.y, expanded.width, expanded.height);
  ctx.setLineDash([]);
  const handleRadius = 4.5 / zoom;
  const corners = [
    [expanded.x, expanded.y],
    [expanded.x + expanded.width, expanded.y],
    [expanded.x, expanded.y + expanded.height],
    [expanded.x + expanded.width, expanded.y + expanded.height],
  ];
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#635bff";
  for (const [x, y] of corners) {
    ctx.beginPath();
    ctx.arc(x, y, handleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export const WhiteboardCanvas = forwardRef<WhiteboardCanvasHandle, WhiteboardCanvasProps>(
  function WhiteboardCanvas(
    {
      documentId,
      snapshot,
      initialSnapshot = EMPTY_BOARD_SNAPSHOT,
      onSnapshotChange,
      tool,
      color = "#1c2434",
      strokeWidth = 3,
      fillColor,
      fontSize = 24,
      viewport,
      initialViewport = DEFAULT_BOARD_VIEWPORT,
      onViewportChange,
      selectedElementIds,
      onSelectionChange,
      onHistoryChange,
      onStrokeEvent,
      allowFingerDrawing = false,
      disabled = false,
      showGrid = true,
      gridSize = 24,
      backgroundColor = "#fbfcff",
      maxHistory = 100,
      className,
      style,
      ariaLabel = "Interactive whiteboard canvas",
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textInputRef = useRef<HTMLTextAreaElement>(null);
    const currentSnapshotRef = useRef<BoardSnapshot>(snapshot ?? initialSnapshot);
    const [, setInternalVersion] = useState(currentSnapshotRef.current.version);
    const undoRef = useRef<BoardSnapshot[]>([]);
    const redoRef = useRef<BoardSnapshot[]>([]);
    const documentIdRef = useRef(documentId);
    const viewportRef = useRef<BoardViewport>({ ...(viewport ?? initialViewport) });
    const [viewportState, setViewportState] = useState<BoardViewport>(viewportRef.current);
    const selectionRef = useRef<string[]>(selectedElementIds ?? EMPTY_SELECTION);
    const [, setSelectionVersion] = useState(0);
    const interactionRef = useRef<Interaction | null>(null);
    const previewElementRef = useRef<BoardElement | null>(null);
    const previewElementsRef = useRef<BoardElement[] | null>(null);
    const activePenPointersRef = useRef(new Set<number>());
    const touchPointsRef = useRef(new Map<number, ScreenPoint>());
    const ignoredTouchPointersRef = useRef(new Set<number>());
    const pinchRef = useRef<PinchGesture | null>(null);
    const spacePressedRef = useRef(false);
    const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
    const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
    const animationFrameRef = useRef<number | null>(null);
    const drawSceneRef = useRef<() => void>(() => undefined);
    const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);

    const scheduleRender = useCallback(() => {
      if (animationFrameRef.current !== null) return;
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        drawSceneRef.current();
      });
    }, []);

    const reportHistory = useCallback(() => {
      onHistoryChange?.({ canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0 });
    }, [onHistoryChange]);

    const emitSnapshot = useCallback(
      (next: BoardSnapshot, reason: BoardChangeReason, addToHistory = true) => {
        const previous = currentSnapshotRef.current;
        if (addToHistory) {
          undoRef.current.push(previous);
          if (undoRef.current.length > maxHistory) undoRef.current.shift();
          redoRef.current = [];
        }
        currentSnapshotRef.current = next;
        setInternalVersion(next.version);
        const availableIds = new Set(next.elements.map((element) => element.id));
        const prunedSelection = selectionRef.current.filter((id) => availableIds.has(id));
        if (prunedSelection.length !== selectionRef.current.length) {
          selectionRef.current = prunedSelection;
          setSelectionVersion((value) => value + 1);
          onSelectionChange?.(prunedSelection);
        }
        const meta = {
          reason,
          canUndo: undoRef.current.length > 0,
          canRedo: redoRef.current.length > 0,
        } satisfies BoardChangeMeta;
        onSnapshotChange?.(next, meta);
        reportHistory();
        scheduleRender();
      },
      [maxHistory, onSelectionChange, onSnapshotChange, reportHistory, scheduleRender],
    );

    const commitElements = useCallback(
      (elements: BoardElement[], reason: BoardChangeReason) => {
        emitSnapshot(
          { version: currentSnapshotRef.current.version + 1, elements },
          reason,
          true,
        );
      },
      [emitSnapshot],
    );

    const setBoardViewport = useCallback(
      (next: BoardViewport) => {
        const normalized = { ...next, zoom: clamp(next.zoom, MIN_ZOOM, MAX_ZOOM) };
        viewportRef.current = normalized;
        setViewportState(normalized);
        onViewportChange?.(normalized);
        scheduleRender();
      },
      [onViewportChange, scheduleRender],
    );

    const updateSelection = useCallback(
      (ids: string[]) => {
        const unique = [...new Set(ids)];
        selectionRef.current = unique;
        setSelectionVersion((value) => value + 1);
        onSelectionChange?.(unique);
        scheduleRender();
      },
      [onSelectionChange, scheduleRender],
    );

    const deleteSelection = useCallback(() => {
      if (selectionRef.current.length === 0 || disabled) return;
      const selected = new Set(selectionRef.current);
      const elements = currentSnapshotRef.current.elements.filter(
        (element) => !selected.has(element.id) || element.locked,
      );
      if (elements.length === currentSnapshotRef.current.elements.length) return;
      updateSelection([]);
      commitElements(elements, "delete");
    }, [commitElements, disabled, updateSelection]);

    const undo = useCallback(() => {
      const previous = undoRef.current.pop();
      if (!previous || disabled) return;
      redoRef.current.push(currentSnapshotRef.current);
      emitSnapshot(previous, "undo", false);
    }, [disabled, emitSnapshot]);

    const redo = useCallback(() => {
      const next = redoRef.current.pop();
      if (!next || disabled) return;
      undoRef.current.push(currentSnapshotRef.current);
      emitSnapshot(next, "redo", false);
    }, [disabled, emitSnapshot]);

    const screenPointFromEvent = useCallback((event: { clientX: number; clientY: number }): ScreenPoint => {
      const rect = canvasRef.current?.getBoundingClientRect();
      return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
    }, []);

    const boardPointFromPointer = useCallback(
      (event: PointerEvent): BoardPoint => {
        const screen = screenPointFromEvent(event);
        const world = screenToWorld(screen, viewportRef.current);
        const pressure = event.pointerType === "mouse" ? 0.5 : event.pressure || 0.5;
        return makePoint(world.x, world.y, pressure, event.timeStamp, event.tiltX, event.tiltY);
      },
      [screenPointFromEvent],
    );

    const getCachedImage = useCallback(
      (url: string): HTMLImageElement | null => {
        if (!url || typeof Image === "undefined") return null;
        const cached = imageCacheRef.current.get(url);
        if (cached) return cached;
        const image = new Image();
        image.decoding = "async";
        image.onload = scheduleRender;
        image.onerror = scheduleRender;
        image.src = url;
        imageCacheRef.current.set(url, image);
        return image;
      },
      [scheduleRender],
    );

    const drawImageEntity = useCallback(
      (ctx: CanvasRenderingContext2D, element: BoardImageElement) => {
        const image = getCachedImage(element.sourceUrl);
        ctx.save();
        ctx.globalAlpha = element.opacity ?? 1;
        roundedRect(ctx, element.x, element.y, element.width, element.height, 6);
        ctx.clip();
        if (image?.complete && image.naturalWidth > 0) {
          ctx.drawImage(image, element.x, element.y, element.width, element.height);
        } else {
          ctx.fillStyle = "#eef1f7";
          ctx.fillRect(element.x, element.y, element.width, element.height);
          ctx.fillStyle = "#6b7280";
          ctx.font = "14px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Loading image…", element.x + element.width / 2, element.y + element.height / 2);
        }
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = "rgba(23, 32, 51, 0.15)";
        ctx.lineWidth = 1;
        roundedRect(ctx, element.x, element.y, element.width, element.height, 6);
        ctx.stroke();
        ctx.restore();
      },
      [getCachedImage],
    );

    const drawScene = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height, dpr } = sizeRef.current;
      const boardViewport = viewportRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      if (showGrid) {
        const spacing = gridSize * boardViewport.zoom;
        if (spacing >= 7) {
          const startX = ((boardViewport.x % spacing) + spacing) % spacing;
          const startY = ((boardViewport.y % spacing) + spacing) % spacing;
          ctx.beginPath();
          for (let x = startX; x < width; x += spacing) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
          }
          for (let y = startY; y < height; y += spacing) {
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
          }
          ctx.strokeStyle = "rgba(92, 103, 132, 0.095)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      ctx.save();
      ctx.translate(boardViewport.x, boardViewport.y);
      ctx.scale(boardViewport.zoom, boardViewport.zoom);
      const elements = previewElementsRef.current ?? currentSnapshotRef.current.elements;
      for (const element of elements) {
        switch (element.type) {
          case "stroke":
            drawStroke(ctx, element);
            break;
          case "line":
          case "rectangle":
          case "ellipse":
          case "arrow":
            drawShape(ctx, element);
            break;
          case "text":
            drawText(ctx, element);
            break;
          case "image":
            drawImageEntity(ctx, element);
            break;
          case "media": {
            const thumbnail = element.thumbnailUrl || (element.kind === "image" ? element.sourceUrl : undefined);
            if (thumbnail) {
              const cached = getCachedImage(thumbnail);
              if (cached?.complete && cached.naturalWidth > 0) {
                ctx.save();
                ctx.globalAlpha = element.opacity ?? 1;
                roundedRect(ctx, element.x, element.y, element.width, element.height, 8);
                ctx.clip();
                ctx.drawImage(cached, element.x, element.y, element.width, element.height);
                ctx.restore();
                break;
              }
            }
            drawMediaCard(ctx, element);
            break;
          }
        }
      }
      const preview = previewElementRef.current;
      if (preview) {
        if (preview.type === "stroke") drawStroke(ctx, preview);
        else if (
          preview.type === "line" ||
          preview.type === "rectangle" ||
          preview.type === "ellipse" ||
          preview.type === "arrow"
        ) {
          drawShape(ctx, preview);
        }
      }
      const selected = elements.filter((element) => selectionRef.current.includes(element.id));
      drawSelection(ctx, selected, boardViewport.zoom);
      const interaction = interactionRef.current;
      if (interaction?.kind === "marquee") {
        const bounds = normalizeBounds({
          x: interaction.start.x,
          y: interaction.start.y,
          width: interaction.current.x - interaction.start.x,
          height: interaction.current.y - interaction.start.y,
        });
        ctx.fillStyle = "rgba(99, 91, 255, 0.08)";
        ctx.strokeStyle = "#635bff";
        ctx.lineWidth = 1 / boardViewport.zoom;
        ctx.setLineDash([5 / boardViewport.zoom, 4 / boardViewport.zoom]);
        ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      }
      ctx.restore();
    }, [backgroundColor, drawImageEntity, getCachedImage, gridSize, showGrid]);

    drawSceneRef.current = drawScene;

    useEffect(() => {
      if (documentIdRef.current === documentId) return;
      documentIdRef.current = documentId;
      undoRef.current = [];
      redoRef.current = [];
      interactionRef.current = null;
      previewElementRef.current = null;
      previewElementsRef.current = null;
      activePenPointersRef.current.clear();
      touchPointsRef.current.clear();
      ignoredTouchPointersRef.current.clear();
      pinchRef.current = null;
      setTextEditor(null);
      updateSelection([]);
      reportHistory();
      scheduleRender();
    }, [documentId, reportHistory, scheduleRender, updateSelection]);

    useEffect(() => {
      if (!snapshot) return;
      currentSnapshotRef.current = snapshot;
      setInternalVersion(snapshot.version);
      const ids = new Set(snapshot.elements.map((element) => element.id));
      if (selectionRef.current.some((id) => !ids.has(id))) {
        updateSelection(selectionRef.current.filter((id) => ids.has(id)));
      }
      scheduleRender();
    }, [scheduleRender, snapshot, updateSelection]);

    useEffect(() => {
      if (!viewport) return;
      viewportRef.current = { ...viewport, zoom: clamp(viewport.zoom, MIN_ZOOM, MAX_ZOOM) };
      setViewportState(viewportRef.current);
      scheduleRender();
    }, [scheduleRender, viewport]);

    useEffect(() => {
      if (!selectedElementIds) return;
      selectionRef.current = [...selectedElementIds];
      setSelectionVersion((value) => value + 1);
      scheduleRender();
    }, [scheduleRender, selectedElementIds]);

    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      const resize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        sizeRef.current = { width, height, dpr };
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        scheduleRender();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      resize();
      return () => observer.disconnect();
    }, [scheduleRender]);

    useEffect(() => {
      scheduleRender();
    }, [scheduleRender, tool, color, strokeWidth, fillColor]);

    useEffect(() => {
      if (!textEditor) return;
      const frame = requestAnimationFrame(() => textInputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }, [textEditor]);

    useEffect(
      () => () => {
        if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      },
      [],
    );

    const findElementAt = useCallback((world: ScreenPoint): BoardElement | undefined => {
      const tolerance = 7 / viewportRef.current.zoom;
      const elements = previewElementsRef.current ?? currentSnapshotRef.current.elements;
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index];
        if (hitTestElement(world, element, tolerance)) return element;
      }
      return undefined;
    }, []);

    const eraseAt = useCallback((world: ScreenPoint) => {
      const interaction = interactionRef.current;
      if (interaction?.kind !== "erase") return;
      const tolerance = Math.max(strokeWidth * 1.7, 10) / viewportRef.current.zoom;
      const filtered = interaction.elements.filter(
        (element) => element.locked || !hitTestElement(world, element, tolerance),
      );
      if (filtered.length !== interaction.elements.length) {
        interaction.elements = filtered;
        interaction.changed = true;
        previewElementsRef.current = filtered;
        updateSelection(selectionRef.current.filter((id) => filtered.some((element) => element.id === id)));
        scheduleRender();
      }
    }, [scheduleRender, strokeWidth, updateSelection]);

    const beginPinchIfReady = useCallback(() => {
      const points = [...touchPointsRef.current.values()];
      if (points.length < 2) return false;
      const [first, second] = points;
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const interrupted = interactionRef.current;
      if (interrupted?.kind === "draw") {
        onStrokeEvent?.({
          type: "cancel",
          pointerId: interrupted.pointerId,
          strokeId: interrupted.element.id,
          sequence: interrupted.sequence + 1,
        });
      }
      interactionRef.current = null;
      previewElementRef.current = null;
      previewElementsRef.current = null;
      pinchRef.current = {
        initialDistance: Math.max(1, distance(first, second)),
        initialCenter: center,
        initialViewport: { ...viewportRef.current },
        worldAtCenter: screenToWorld(center, viewportRef.current),
      };
      scheduleRender();
      return true;
    }, [onStrokeEvent, scheduleRender]);

    const handlePointerDown = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (disabled || event.button > 1) return;
        const canvas = canvasRef.current;
        canvas?.focus({ preventScroll: true });
        canvas?.setPointerCapture(event.pointerId);
        const screen = screenPointFromEvent(event.nativeEvent);

        if (event.pointerType === "pen") activePenPointersRef.current.add(event.pointerId);
        if (event.pointerType === "touch") {
          if (activePenPointersRef.current.size > 0) {
            ignoredTouchPointersRef.current.add(event.pointerId);
            return;
          }
          touchPointsRef.current.set(event.pointerId, screen);
          if (beginPinchIfReady()) return;
          if (!allowFingerDrawing) {
            interactionRef.current = { kind: "pan", pointerId: event.pointerId, last: screen };
            return;
          }
        }

        if (event.button === 1 || spacePressedRef.current || tool === "pan") {
          interactionRef.current = { kind: "pan", pointerId: event.pointerId, last: screen };
          return;
        }

        const world = screenToWorld(screen, viewportRef.current);
        const point = boardPointFromPointer(event.nativeEvent);

        if (tool === "pen" || tool === "highlighter") {
          const element: BoardStrokeElement = {
            id: createId("stroke"),
            type: "stroke",
            tool,
            color,
            width: strokeWidth,
            points: [point],
            createdAt: Date.now(),
          };
          interactionRef.current = { kind: "draw", pointerId: event.pointerId, element, sequence: 0 };
          previewElementRef.current = element;
          onStrokeEvent?.({
            type: "begin",
            pointerId: event.pointerId,
            sequence: 0,
            stroke: { ...element, points: [{ ...point }] },
            firstPoint: { ...point },
          });
          scheduleRender();
          return;
        }

        if (isShapeTool(tool)) {
          const element: BoardShapeElement = {
            id: createId("shape"),
            type: tool,
            start: point,
            end: point,
            color,
            width: strokeWidth,
            fill: fillColor,
            createdAt: Date.now(),
          };
          interactionRef.current = { kind: "shape", pointerId: event.pointerId, element };
          previewElementRef.current = element;
          scheduleRender();
          return;
        }

        if (tool === "eraser") {
          const elements = currentSnapshotRef.current.elements;
          interactionRef.current = {
            kind: "erase",
            pointerId: event.pointerId,
            original: elements,
            elements,
            changed: false,
          };
          eraseAt(world);
          return;
        }

        if (tool === "text") {
          setTextEditor({ world, value: "" });
          return;
        }

        if (tool === "select") {
          const selected = currentSnapshotRef.current.elements.filter((element) =>
            selectionRef.current.includes(element.id),
          );
          if (selected.length === 1 && (selected[0].type === "image" || selected[0].type === "media")) {
            const bounds = inflateBounds(getElementBounds(selected[0]), 5 / viewportRef.current.zoom);
            const handle = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
            if (distance(world, handle) <= 12 / viewportRef.current.zoom) {
              const original = selected[0];
              interactionRef.current = {
                kind: "resize",
                pointerId: event.pointerId,
                start: world,
                original,
                aspectRatio: original.width / Math.max(1, original.height),
              };
              return;
            }
          }
          const hit = findElementAt(world);
          if (hit && !hit.locked) {
            let nextSelection = selectionRef.current;
            if (event.shiftKey) {
              nextSelection = nextSelection.includes(hit.id)
                ? nextSelection.filter((id) => id !== hit.id)
                : [...nextSelection, hit.id];
            } else if (!nextSelection.includes(hit.id)) {
              nextSelection = [hit.id];
            }
            updateSelection(nextSelection);
            const selectedSet = new Set(nextSelection);
            interactionRef.current = {
              kind: "move",
              pointerId: event.pointerId,
              start: world,
              original: currentSnapshotRef.current.elements.filter((element) => selectedSet.has(element.id)),
              moved: false,
            };
          } else {
            const baseSelection = event.shiftKey ? selectionRef.current : [];
            if (!event.shiftKey) updateSelection([]);
            interactionRef.current = {
              kind: "marquee",
              pointerId: event.pointerId,
              start: world,
              current: world,
              baseSelection,
            };
          }
        }
      },
      [
        allowFingerDrawing,
        beginPinchIfReady,
        boardPointFromPointer,
        color,
        disabled,
        eraseAt,
        fillColor,
        findElementAt,
        onStrokeEvent,
        scheduleRender,
        screenPointFromEvent,
        strokeWidth,
        tool,
        updateSelection,
      ],
    );

    const updatePinch = useCallback(() => {
      const pinch = pinchRef.current;
      const points = [...touchPointsRef.current.values()];
      if (!pinch || points.length < 2) return;
      const [first, second] = points;
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const zoom = clamp(
        pinch.initialViewport.zoom * (distance(first, second) / pinch.initialDistance),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      setBoardViewport({
        x: center.x - pinch.worldAtCenter.x * zoom,
        y: center.y - pinch.worldAtCenter.y * zoom,
        zoom,
      });
    }, [setBoardViewport]);

    const handlePointerMove = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (ignoredTouchPointersRef.current.has(event.pointerId)) return;
        const screen = screenPointFromEvent(event.nativeEvent);
        if (event.pointerType === "touch") {
          touchPointsRef.current.set(event.pointerId, screen);
          if (pinchRef.current) {
            updatePinch();
            return;
          }
        }
        const interaction = interactionRef.current;
        if (!interaction || interaction.pointerId !== event.pointerId) return;

        if (interaction.kind === "pan") {
          const dx = screen.x - interaction.last.x;
          const dy = screen.y - interaction.last.y;
          interaction.last = screen;
          setBoardViewport({
            ...viewportRef.current,
            x: viewportRef.current.x + dx,
            y: viewportRef.current.y + dy,
          });
          return;
        }

        const world = screenToWorld(screen, viewportRef.current);
        if (interaction.kind === "draw") {
          const native = event.nativeEvent;
          const coalesced = native.getCoalescedEvents?.() ?? [native];
          const newPoints: BoardPoint[] = [];
          for (const sample of coalesced) {
            const point = boardPointFromPointer(sample);
            const last = interaction.element.points.at(-1);
            if (!last || distance(last, point) > 0.12 / viewportRef.current.zoom) {
              interaction.element.points.push(point);
              newPoints.push({ ...point });
            }
          }
          if (newPoints.length > 0) {
            interaction.sequence += 1;
            onStrokeEvent?.({
              type: "points",
              pointerId: interaction.pointerId,
              strokeId: interaction.element.id,
              sequence: interaction.sequence,
              points: newPoints,
            });
          }
          previewElementRef.current = interaction.element;
          scheduleRender();
          return;
        }

        if (interaction.kind === "shape") {
          let end = boardPointFromPointer(event.nativeEvent);
          if (event.shiftKey) {
            const dx = end.x - interaction.element.start.x;
            const dy = end.y - interaction.element.start.y;
            if (interaction.element.type === "rectangle" || interaction.element.type === "ellipse") {
              const size = Math.max(Math.abs(dx), Math.abs(dy));
              end = {
                ...end,
                x: interaction.element.start.x + Math.sign(dx || 1) * size,
                y: interaction.element.start.y + Math.sign(dy || 1) * size,
              };
            } else {
              const length = Math.hypot(dx, dy);
              const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
              end = {
                ...end,
                x: interaction.element.start.x + Math.cos(angle) * length,
                y: interaction.element.start.y + Math.sin(angle) * length,
              };
            }
          }
          interaction.element.end = end;
          previewElementRef.current = interaction.element;
          scheduleRender();
          return;
        }

        if (interaction.kind === "erase") {
          eraseAt(world);
          return;
        }

        if (interaction.kind === "move") {
          const dx = world.x - interaction.start.x;
          const dy = world.y - interaction.start.y;
          interaction.moved = interaction.moved || Math.hypot(dx, dy) > 0.5 / viewportRef.current.zoom;
          const selectedById = new Map(
            interaction.original.map((element) => [element.id, translateElement(element, dx, dy)]),
          );
          previewElementsRef.current = currentSnapshotRef.current.elements.map(
            (element) => selectedById.get(element.id) ?? element,
          );
          scheduleRender();
          return;
        }

        if (interaction.kind === "resize") {
          let width = Math.max(40 / viewportRef.current.zoom, interaction.original.width + world.x - interaction.start.x);
          let height = Math.max(32 / viewportRef.current.zoom, interaction.original.height + world.y - interaction.start.y);
          if (event.shiftKey) height = width / interaction.aspectRatio;
          if (!event.shiftKey && interaction.original.type === "image") {
            const candidateHeight = width / interaction.aspectRatio;
            if (Math.abs(world.y - interaction.start.y) < Math.abs(world.x - interaction.start.x)) {
              height = candidateHeight;
            } else {
              width = height * interaction.aspectRatio;
            }
          }
          const resized = { ...interaction.original, width, height };
          previewElementsRef.current = currentSnapshotRef.current.elements.map((element) =>
            element.id === resized.id ? resized : element,
          );
          scheduleRender();
          return;
        }

        if (interaction.kind === "marquee") {
          interaction.current = world;
          const marqueeBounds = normalizeBounds({
            x: interaction.start.x,
            y: interaction.start.y,
            width: world.x - interaction.start.x,
            height: world.y - interaction.start.y,
          });
          const hitIds = currentSnapshotRef.current.elements
            .filter((element) => !element.locked && boundsIntersect(marqueeBounds, getElementBounds(element)))
            .map((element) => element.id);
          updateSelection([...interaction.baseSelection, ...hitIds]);
          scheduleRender();
        }
      },
      [
        boardPointFromPointer,
        eraseAt,
        onStrokeEvent,
        scheduleRender,
        screenPointFromEvent,
        setBoardViewport,
        updatePinch,
        updateSelection,
      ],
    );

    const finishInteraction = useCallback(
      (pointerId: number, commit: boolean) => {
        const interaction = interactionRef.current;
        if (!interaction || interaction.pointerId !== pointerId) return;
        if (commit) {
          switch (interaction.kind) {
            case "draw":
              onStrokeEvent?.({
                type: "end",
                pointerId: interaction.pointerId,
                sequence: interaction.sequence + 1,
                stroke: {
                  ...interaction.element,
                  points: interaction.element.points.map((point) => ({ ...point })),
                },
              });
              commitElements([...currentSnapshotRef.current.elements, interaction.element], "draw");
              break;
            case "shape":
              if (distance(interaction.element.start, interaction.element.end) > 0.5) {
                commitElements([...currentSnapshotRef.current.elements, interaction.element], "shape");
              }
              break;
            case "erase":
              if (interaction.changed) commitElements(interaction.elements, "erase");
              break;
            case "move":
              if (interaction.moved && previewElementsRef.current) {
                commitElements(previewElementsRef.current, "move");
              }
              break;
            case "resize":
              if (previewElementsRef.current) commitElements(previewElementsRef.current, "move");
              break;
            case "pan":
            case "marquee":
              break;
          }
        } else if (interaction.kind === "draw") {
          onStrokeEvent?.({
            type: "cancel",
            pointerId: interaction.pointerId,
            strokeId: interaction.element.id,
            sequence: interaction.sequence + 1,
          });
        }
        interactionRef.current = null;
        previewElementRef.current = null;
        previewElementsRef.current = null;
        scheduleRender();
      },
      [commitElements, onStrokeEvent, scheduleRender],
    );

    const handlePointerEnd = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
        if (event.pointerType === "pen") activePenPointersRef.current.delete(event.pointerId);
        ignoredTouchPointersRef.current.delete(event.pointerId);
        if (event.pointerType === "touch") {
          touchPointsRef.current.delete(event.pointerId);
          if (pinchRef.current) {
            if (touchPointsRef.current.size < 2) pinchRef.current = null;
            interactionRef.current = null;
            return;
          }
        }
        finishInteraction(event.pointerId, commit);
      },
      [finishInteraction],
    );

    const handleWheel = useCallback(
      (event: ReactWheelEvent<HTMLCanvasElement>) => {
        if (disabled) return;
        event.preventDefault();
        const screen = screenPointFromEvent(event.nativeEvent);
        if (event.ctrlKey || event.metaKey) {
          const zoomFactor = Math.exp(-event.deltaY * 0.002);
          setBoardViewport(zoomViewportAt(viewportRef.current, screen, viewportRef.current.zoom * zoomFactor));
        } else {
          setBoardViewport({
            ...viewportRef.current,
            x: viewportRef.current.x - event.deltaX,
            y: viewportRef.current.y - event.deltaY,
          });
        }
      },
      [disabled, screenPointFromEvent, setBoardViewport],
    );

    const commitTextEditor = useCallback(() => {
      if (!textEditor) return;
      const value = textEditor.value.trimEnd();
      if (value.trim()) {
        const lines = value.split("\n");
        const longest = lines.reduce((longestLine, line) => (line.length > longestLine.length ? line : longestLine), "");
        const element: BoardTextElement = {
          id: createId("text"),
          type: "text",
          x: textEditor.world.x,
          y: textEditor.world.y,
          text: value,
          color,
          fontSize,
          width: Math.max(fontSize, longest.length * fontSize * 0.58),
          height: lines.length * fontSize * 1.25,
          createdAt: Date.now(),
        };
        commitElements([...currentSnapshotRef.current.elements, element], "text");
        updateSelection([element.id]);
      }
      setTextEditor(null);
    }, [color, commitElements, fontSize, textEditor, updateSelection]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLCanvasElement>) => {
        if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
        if (event.code === "Space") {
          spacePressedRef.current = true;
          event.preventDefault();
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          event.preventDefault();
          updateSelection(currentSnapshotRef.current.elements.filter((element) => !element.locked).map((element) => element.id));
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          deleteSelection();
        } else if (event.key === "Escape") {
          interactionRef.current = null;
          previewElementRef.current = null;
          previewElementsRef.current = null;
          setTextEditor(null);
          updateSelection([]);
        }
      },
      [deleteSelection, redo, undo, updateSelection],
    );

    useImperativeHandle(
      ref,
      () => ({
        undo,
        redo,
        deleteSelection,
        clearSelection: () => updateSelection([]),
        resetViewport: () => setBoardViewport({ ...DEFAULT_BOARD_VIEWPORT }),
        fitToContent: (padding = 64) => {
          const bounds = getElementsBounds(currentSnapshotRef.current.elements);
          if (!bounds) {
            setBoardViewport({ ...DEFAULT_BOARD_VIEWPORT });
            return;
          }
          const { width, height } = sizeRef.current;
          const usableWidth = Math.max(1, width - padding * 2);
          const usableHeight = Math.max(1, height - padding * 2);
          const zoom = clamp(
            Math.min(usableWidth / Math.max(bounds.width, 1), usableHeight / Math.max(bounds.height, 1)),
            MIN_ZOOM,
            MAX_ZOOM,
          );
          setBoardViewport({
            zoom,
            x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
            y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
          });
        },
        getSnapshot: () => currentSnapshotRef.current,
        getViewport: () => viewportRef.current,
        addElements: (elements) => {
          if (!elements.length || disabled) return;
          commitElements([...currentSnapshotRef.current.elements, ...elements], "external");
        },
        exportViewportPng: () => {
          try {
            drawSceneRef.current();
            return canvasRef.current?.toDataURL("image/png") ?? null;
          } catch {
            return null;
          }
        },
        focus: () => canvasRef.current?.focus(),
      }),
      [commitElements, deleteSelection, disabled, redo, setBoardViewport, undo, updateSelection],
    );

    const textScreenPosition = textEditor
      ? worldToScreen(textEditor.world, viewportState)
      : null;
    const cursor = disabled
      ? "not-allowed"
      : tool === "pan" || spacePressedRef.current
        ? "grab"
        : tool === "select"
          ? "default"
          : tool === "text"
            ? "text"
            : "crosshair";

    return (
      <div
        ref={containerRef}
        className={className}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          outline: "none",
          ...style,
        }}
      >
        <canvas
          ref={canvasRef}
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label={`${ariaLabel}. Use the selected drawing tool, two fingers to pan and zoom, and Command or Control Z to undo.`}
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
            touchAction: "none",
            cursor,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => handlePointerEnd(event, true)}
          onPointerCancel={(event) => handlePointerEnd(event, false)}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (event.code === "Space") spacePressedRef.current = false;
          }}
          onBlur={() => {
            spacePressedRef.current = false;
          }}
        />
        {textEditor && textScreenPosition ? (
          <textarea
            ref={textInputRef}
            aria-label="Enter whiteboard text"
            value={textEditor.value}
            onChange={(event) => setTextEditor({ ...textEditor, value: event.target.value })}
            onBlur={commitTextEditor}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setTextEditor(null);
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitTextEditor();
              }
            }}
            placeholder="Type text"
            rows={1}
            style={{
              position: "absolute",
              left: textScreenPosition.x,
              top: textScreenPosition.y,
              zIndex: 2,
              minWidth: 180,
              minHeight: Math.max(36, fontSize * viewportState.zoom * 1.4),
              padding: "4px 6px",
              border: "1px solid #635bff",
              borderRadius: 5,
              outline: "2px solid rgba(99, 91, 255, 0.16)",
              resize: "both",
              overflow: "hidden",
              color,
              background: "rgba(255,255,255,0.96)",
              font: `${fontSize * viewportState.zoom}px Inter, ui-sans-serif, system-ui, sans-serif`,
              lineHeight: 1.25,
            }}
          />
        ) : null}
        <span
          aria-live="polite"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0, 0, 0, 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {selectionRef.current.length
            ? `${selectionRef.current.length} element${selectionRef.current.length === 1 ? "" : "s"} selected`
            : "No elements selected"}
        </span>
      </div>
    );
  },
);

WhiteboardCanvas.displayName = "WhiteboardCanvas";
