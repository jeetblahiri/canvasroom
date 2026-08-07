/** Serializable, framework-agnostic types used by the whiteboard canvas. */

export type DrawingTool = "pen" | "highlighter";

export type ShapeTool = "line" | "rectangle" | "ellipse" | "arrow";

export type BoardTool =
  | "select"
  | "pan"
  | DrawingTool
  | "eraser"
  | ShapeTool
  | "text";

export interface BoardPoint {
  x: number;
  y: number;
  /** Normalized Pointer Events pressure, from 0 to 1. */
  pressure: number;
  /** Milliseconds relative to the browser time origin. */
  time: number;
  tiltX?: number;
  tiltY?: number;
}

export interface BoardViewport {
  /** Horizontal screen-space offset in CSS pixels. */
  x: number;
  /** Vertical screen-space offset in CSS pixels. */
  y: number;
  zoom: number;
}

export interface BoardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardElementBase {
  id: string;
  opacity?: number;
  locked?: boolean;
  createdAt?: number;
}

export interface BoardStrokeElement extends BoardElementBase {
  type: "stroke";
  tool: DrawingTool;
  points: BoardPoint[];
  color: string;
  /** Width in board/world units. */
  width: number;
}

export interface BoardShapeElement extends BoardElementBase {
  type: ShapeTool;
  start: BoardPoint;
  end: BoardPoint;
  color: string;
  width: number;
  fill?: string;
}

export interface BoardTextElement extends BoardElementBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  fontFamily?: string;
  /** Cached world-space box. It is recalculated when rendered. */
  width?: number;
  height?: number;
}

export interface BoardImageElement extends BoardElementBase {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  /** An object URL, data URL, or same-origin URL. */
  sourceUrl: string;
  alt?: string;
  assetId?: string;
}

export type BoardMediaKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "link"
  | "file";

/**
 * A board-level media card. `sourceUrl` should normally be an object URL or a
 * same-origin URL; cross-origin images may make PNG export unavailable.
 */
export interface BoardMediaElement extends BoardElementBase {
  type: "media";
  kind: BoardMediaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  assetId?: string;
  href?: string;
}

export type BoardElement =
  | BoardStrokeElement
  | BoardShapeElement
  | BoardTextElement
  | BoardImageElement
  | BoardMediaElement;

export interface BoardSnapshot {
  /** Monotonically increasing for locally committed operations. */
  version: number;
  elements: BoardElement[];
}

export type BoardChangeReason =
  | "draw"
  | "erase"
  | "shape"
  | "text"
  | "move"
  | "delete"
  | "undo"
  | "redo"
  | "external";

export interface BoardChangeMeta {
  reason: BoardChangeReason;
  canUndo: boolean;
  canRedo: boolean;
}

export interface BoardHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/** Low-latency events that can be forwarded to a paired drawing device. */
export type WhiteboardStrokeEvent =
  | {
      type: "begin";
      pointerId: number;
      sequence: 0;
      /** An immutable stroke snapshot containing only the first point. */
      stroke: BoardStrokeElement;
      firstPoint: BoardPoint;
    }
  | {
      type: "points";
      pointerId: number;
      strokeId: string;
      /** Monotonically increasing per-stroke batch number, starting at 1. */
      sequence: number;
      /** Only points newly accepted since the preceding event. */
      points: BoardPoint[];
    }
  | {
      type: "end";
      pointerId: number;
      sequence: number;
      /** The immutable finalized stroke, useful for reliable reconciliation. */
      stroke: BoardStrokeElement;
    }
  | {
      type: "cancel";
      pointerId: number;
      strokeId: string;
      sequence: number;
    };

export const EMPTY_BOARD_SNAPSHOT: BoardSnapshot = Object.freeze({
  version: 0,
  elements: [],
});

export const DEFAULT_BOARD_VIEWPORT: BoardViewport = Object.freeze({
  x: 0,
  y: 0,
  zoom: 1,
});
