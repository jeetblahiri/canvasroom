import type {
  BoardBounds,
  BoardElement,
  BoardImageElement,
  BoardMediaElement,
  BoardPoint,
  BoardShapeElement,
  BoardStrokeElement,
  BoardTextElement,
  BoardViewport,
} from "./board-types";

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 8;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function screenToWorld(
  point: Pick<BoardPoint, "x" | "y">,
  viewport: BoardViewport,
): { x: number; y: number } {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function worldToScreen(
  point: Pick<BoardPoint, "x" | "y">,
  viewport: BoardViewport,
): { x: number; y: number } {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

export function zoomViewportAt(
  viewport: BoardViewport,
  screenPoint: { x: number; y: number },
  nextZoom: number,
): BoardViewport {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const world = screenToWorld(screenPoint, viewport);
  return {
    x: screenPoint.x - world.x * zoom,
    y: screenPoint.y - world.y * zoom,
    zoom,
  };
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return distance(point, start);
  const lengthSquared = dx * dx + dy * dy;
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return distance(point, { x: start.x + dx * t, y: start.y + dy * t });
}

export function normalizeBounds(bounds: BoardBounds): BoardBounds {
  return {
    x: bounds.width < 0 ? bounds.x + bounds.width : bounds.x,
    y: bounds.height < 0 ? bounds.y + bounds.height : bounds.y,
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

export function inflateBounds(bounds: BoardBounds, amount: number): BoardBounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

export function pointInBounds(point: { x: number; y: number }, bounds: BoardBounds): boolean {
  const normalized = normalizeBounds(bounds);
  return (
    point.x >= normalized.x &&
    point.y >= normalized.y &&
    point.x <= normalized.x + normalized.width &&
    point.y <= normalized.y + normalized.height
  );
}

export function boundsIntersect(a: BoardBounds, b: BoardBounds): boolean {
  const aa = normalizeBounds(a);
  const bb = normalizeBounds(b);
  return !(
    aa.x + aa.width < bb.x ||
    bb.x + bb.width < aa.x ||
    aa.y + aa.height < bb.y ||
    bb.y + bb.height < aa.y
  );
}

function pointsBounds(points: readonly { x: number; y: number }[]): BoardBounds {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function getElementBounds(element: BoardElement): BoardBounds {
  switch (element.type) {
    case "stroke":
      return inflateBounds(pointsBounds(element.points), element.width / 2);
    case "line":
    case "arrow":
    case "rectangle":
    case "ellipse":
      return inflateBounds(
        normalizeBounds({
          x: element.start.x,
          y: element.start.y,
          width: element.end.x - element.start.x,
          height: element.end.y - element.start.y,
        }),
        element.width / 2,
      );
    case "text":
      return {
        x: element.x,
        y: element.y,
        width: element.width ?? Math.max(element.fontSize, element.text.length * element.fontSize * 0.56),
        height: element.height ?? element.fontSize * 1.25,
      };
    case "media":
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    case "image":
      return { x: element.x, y: element.y, width: element.width, height: element.height };
  }
}

export function getElementsBounds(elements: readonly BoardElement[]): BoardBounds | null {
  if (elements.length === 0) return null;
  const first = getElementBounds(elements[0]);
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.width;
  let maxY = first.y + first.height;
  for (let index = 1; index < elements.length; index += 1) {
    const bounds = getElementBounds(elements[index]);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function hitStroke(point: { x: number; y: number }, stroke: BoardStrokeElement, tolerance: number): boolean {
  const radius = tolerance + stroke.width / 2;
  if (stroke.points.length === 1) return distance(point, stroke.points[0]) <= radius;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (distanceToSegment(point, stroke.points[index - 1], stroke.points[index]) <= radius) return true;
  }
  return false;
}

function hitShape(point: { x: number; y: number }, shape: BoardShapeElement, tolerance: number): boolean {
  const radius = tolerance + shape.width / 2;
  if (shape.type === "line" || shape.type === "arrow") {
    return distanceToSegment(point, shape.start, shape.end) <= radius;
  }
  const bounds = normalizeBounds({
    x: shape.start.x,
    y: shape.start.y,
    width: shape.end.x - shape.start.x,
    height: shape.end.y - shape.start.y,
  });
  if (shape.fill && pointInBounds(point, bounds)) return true;
  if (shape.type === "rectangle") {
    const outer = inflateBounds(bounds, radius);
    const inner = inflateBounds(bounds, -radius);
    return pointInBounds(point, outer) && (!pointInBounds(point, inner) || inner.width <= 0 || inner.height <= 0);
  }
  const rx = Math.max(bounds.width / 2, 0.001);
  const ry = Math.max(bounds.height / 2, 0.001);
  const cx = bounds.x + rx;
  const cy = bounds.y + ry;
  const normalizedDistance = Math.hypot((point.x - cx) / rx, (point.y - cy) / ry);
  const normalizedTolerance = radius / Math.max(1, Math.min(rx, ry));
  return Math.abs(normalizedDistance - 1) <= normalizedTolerance;
}

export function hitTestElement(
  point: { x: number; y: number },
  element: BoardElement,
  tolerance = 5,
): boolean {
  if (!pointInBounds(point, inflateBounds(getElementBounds(element), tolerance))) return false;
  switch (element.type) {
    case "stroke":
      return hitStroke(point, element, tolerance);
    case "line":
    case "rectangle":
    case "ellipse":
    case "arrow":
      return hitShape(point, element, tolerance);
    case "text":
    case "media":
    case "image":
      return pointInBounds(point, getElementBounds(element));
  }
}

export function translateElement(element: BoardElement, dx: number, dy: number): BoardElement {
  switch (element.type) {
    case "stroke":
      return {
        ...element,
        points: element.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
      } satisfies BoardStrokeElement;
    case "line":
    case "rectangle":
    case "ellipse":
    case "arrow":
      return {
        ...element,
        start: { ...element.start, x: element.start.x + dx, y: element.start.y + dy },
        end: { ...element.end, x: element.end.x + dx, y: element.end.y + dy },
      } satisfies BoardShapeElement;
    case "text":
      return { ...element, x: element.x + dx, y: element.y + dy } satisfies BoardTextElement;
    case "media":
      return { ...element, x: element.x + dx, y: element.y + dy } satisfies BoardMediaElement;
    case "image":
      return { ...element, x: element.x + dx, y: element.y + dy } satisfies BoardImageElement;
  }
}

export function makePoint(
  x: number,
  y: number,
  pressure = 0.5,
  time = performance.now(),
  tiltX?: number,
  tiltY?: number,
): BoardPoint {
  return { x, y, pressure: clamp(pressure || 0.5, 0.01, 1), time, tiltX, tiltY };
}
