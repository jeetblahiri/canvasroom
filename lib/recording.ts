/**
 * Browser-only whiteboard recording utilities.
 *
 * The recorder prefers an origin-clean board canvas, but falls back to the
 * browser's screen/window picker when a canvas is not supplied or cannot be
 * captured. A compositor canvas keeps the saved output independent of the UI
 * and provides a predictable place for the optional webcam overlay.
 */

export type RecordingStatus =
  | "idle"
  | "preparing"
  | "previewing"
  | "recording"
  | "paused"
  | "stopping"
  | "error";

export type WebcamShape = "circle" | "square";
export type WebcamPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export type WebcamSize = "small" | "medium" | "large";
export type RecordingCaptureMode = "canvas" | "screen";

export interface WebcamOverlayOptions {
  shape: WebcamShape;
  position: WebcamPosition;
  size: WebcamSize;
  /** Distance from the output edge in CSS-independent recording pixels. */
  margin?: number;
  /** Draw the camera mirrored, as most self-view UIs do. */
  mirror?: boolean;
}

export interface RecordingToolRailItem {
  id: string;
  label: string;
  shortcut: string;
}

export interface RecordingToolRailOptions {
  activeTool: string;
  /** Width of the on-screen rail in CSS pixels. */
  width?: number;
  items: RecordingToolRailItem[];
}

export interface RecordingStartOptions {
  /** Record either the supplied board canvas or a browser-selected tab/screen. */
  captureMode?: RecordingCaptureMode;
  /** The preferred board source. It must be origin-clean for captureStream(). */
  sourceCanvas?: HTMLCanvasElement | null;
  includeMicrophone?: boolean;
  includeCamera?: boolean;
  includeDisplayAudio?: boolean;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  frameRate?: number;
  maxWidth?: number;
  maxHeight?: number;
  videoBitsPerSecond?: number;
  preferredMimeTypes?: string[];
  webcam?: Partial<WebcamOverlayOptions>;
  /** Draw a presentation-safe copy of the pen toolbar beside the board. */
  toolRail?: RecordingToolRailOptions;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  suggestedFileName: string;
}

export interface RecordingPreview {
  /** The exact composited stream that will be passed to MediaRecorder. */
  stream: MediaStream;
  /** Camera-only stream for the visible presenter self-view. */
  cameraStream?: MediaStream;
  width: number;
  height: number;
}

export interface RecordingCallbacks {
  onStatusChange?: (status: RecordingStatus) => void;
  onError?: (error: Error) => void;
  /** Called if the browser's screen-sharing UI ends capture unexpectedly. */
  onSourceEnded?: (result: RecordingResult) => void | Promise<void>;
}

interface WritableFileLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

interface FileHandleLike {
  name?: string;
  createWritable(): Promise<WritableFileLike>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileHandleLike>;
}

export type RecordingSaveTarget =
  | { kind: "file-system"; handle: FileHandleLike }
  | { kind: "download" }
  | { kind: "cancelled" };

export interface RecordingSaveResult {
  method: "file-system" | "download";
  fileName: string;
}

const DEFAULT_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

const DEFAULT_WEBCAM: WebcamOverlayOptions = {
  shape: "circle",
  position: "bottom-right",
  size: "medium",
  margin: 32,
  mirror: true,
};

type StopResolution = {
  resolve: (result: RecordingResult) => void;
  reject: (error: Error) => void;
};

function asError(value: unknown, fallback = "Recording failed."): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : fallback);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const safeWidth = Math.max(2, Math.round(width || maxWidth));
  const safeHeight = Math.max(2, Math.round(height || maxHeight));
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  // Media encoders are happiest with even dimensions.
  return {
    width: Math.max(2, Math.round((safeWidth * scale) / 2) * 2),
    height: Math.max(2, Math.round((safeHeight * scale) / 2) * 2),
  };
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return video.play().then(() => undefined);
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The selected video source did not become ready."));
    }, 10_000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("error", handleError);
    };
    const handleReady = () => {
      cleanup();
      video.play().then(() => resolve(), reject);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The selected video source could not be loaded."));
    };

    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function createMutedVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  return video;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function drawContained(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  targetX = 0,
  targetY = 0,
): void {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.drawImage(
    source,
    targetX + (targetWidth - width) / 2,
    targetY + (targetHeight - height) / 2,
    width,
    height,
  );
}

function drawRecordingToolRail(
  context: CanvasRenderingContext2D,
  options: RecordingToolRailOptions,
  width: number,
  height: number,
): void {
  context.save();
  context.fillStyle = "#111513";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = Math.max(1, width * 0.015);
  context.beginPath();
  context.moveTo(width - context.lineWidth / 2, 0);
  context.lineTo(width - context.lineWidth / 2, height);
  context.stroke();

  const items = options.items.slice(0, 14);
  const gap = Math.max(4, width * 0.08);
  const horizontalPadding = Math.max(6, width * 0.16);
  const availableWidth = Math.max(16, width - horizontalPadding * 2);
  const availableHeight = Math.max(40, height - gap * 2);
  const buttonSize = Math.max(16, Math.min(availableWidth, (availableHeight - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length)));
  const totalHeight = items.length * buttonSize + Math.max(0, items.length - 1) * gap;
  let y = Math.max(gap, (height - totalHeight) / 2);

  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const item of items) {
    const x = (width - buttonSize) / 2;
    const active = item.id === options.activeTool;
    const radius = Math.max(4, buttonSize * 0.2);
    context.beginPath();
    context.roundRect(x, y, buttonSize, buttonSize, radius);
    context.fillStyle = active ? "#cdf458" : "rgba(255,255,255,0.065)";
    context.fill();
    if (active) {
      context.strokeStyle = "rgba(205,244,88,0.72)";
      context.lineWidth = Math.max(1, buttonSize * 0.04);
      context.stroke();
    }
    context.fillStyle = active ? "#111513" : "#eef2ef";
    context.font = `700 ${Math.max(9, buttonSize * 0.34)}px ui-sans-serif, system-ui, sans-serif`;
    context.fillText(item.shortcut, width / 2, y + buttonSize / 2, buttonSize * 0.72);
    y += buttonSize + gap;
  }
  context.restore();
}

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  size: number,
): void {
  const videoWidth = video.videoWidth || size;
  const videoHeight = video.videoHeight || size;
  const sourceSize = Math.min(videoWidth, videoHeight);
  const sourceX = (videoWidth - sourceSize) / 2;
  const sourceY = (videoHeight - sourceSize) / 2;
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    x,
    y,
    size,
    size,
  );
}

/** Return the first container/codec combination supported by this browser. */
export function selectRecordingMimeType(preferred = DEFAULT_MIME_TYPES): string {
  if (typeof MediaRecorder === "undefined") return "";
  return preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof MediaStream !== "undefined" &&
    Boolean(navigator.mediaDevices)
  );
}

export function recordingFileExtension(mimeType: string): "mp4" | "webm" {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

export function createRecordingFileName(
  mimeType: string,
  date = new Date(),
): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll(":", "-");
  return `whiteboard-recording-${stamp}.${recordingFileExtension(mimeType)}`;
}

/**
 * Convert browser security/permission errors into messages that are useful in
 * a recording UI while keeping the original Error available to callers.
 */
export function humanizeRecordingError(error: unknown): string {
  const value = asError(error);
  switch (value.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera, microphone, or screen access was denied. Allow access in your browser and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "The requested camera or microphone is not available.";
    case "NotReadableError":
    case "TrackStartError":
      return "A camera, microphone, or screen source is already in use or could not be read.";
    case "AbortError":
      return "Recording setup was cancelled.";
    case "SecurityError":
      return "The browser blocked capture. Open the app over HTTPS and make sure embedded media permits recording.";
    case "OverconstrainedError":
      return "The selected recording device does not support the requested settings.";
    default:
      return value.message || "Recording could not be started.";
  }
}

/**
 * Open the native save dialog. Call this directly from a click handler so the
 * browser still considers it a user gesture. Unsupported pickers use the
 * download fallback; cancelling a supported picker explicitly saves nothing.
 */
export async function requestRecordingSaveTarget(options: {
  suggestedFileName: string;
  mimeType: string;
}): Promise<RecordingSaveTarget> {
  if (typeof window === "undefined") return { kind: "download" };

  const pickerWindow = window as SaveFilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return { kind: "download" };

  const extension = `.${recordingFileExtension(options.mimeType)}`;
  try {
    const handle = await pickerWindow.showSaveFilePicker({
      suggestedName: options.suggestedFileName,
      types: [
        {
          description: "Whiteboard recording",
          accept: {
            [options.mimeType.split(";")[0] || "video/webm"]: [extension],
          },
        },
      ],
    });
    return { kind: "file-system", handle };
  } catch (error) {
    if (asError(error).name === "AbortError") {
      return { kind: "cancelled" };
    }
    // Saving can still proceed safely through a browser download.
    return { kind: "download" };
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function saveRecordingBlob(
  blob: Blob,
  options: {
    fileName: string;
    target?: RecordingSaveTarget;
  },
): Promise<RecordingSaveResult> {
  if (typeof document === "undefined") {
    throw new Error("Recordings can only be saved in a browser.");
  }

  const target = options.target ?? { kind: "download" };
  if (target.kind === "cancelled") {
    throw new DOMException("The save dialog was cancelled.", "AbortError");
  }
  if (target.kind === "file-system") {
    let writable: WritableFileLike | null = null;
    try {
      writable = await target.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        method: "file-system",
        fileName: target.handle.name || options.fileName,
      };
    } catch {
      try {
        await writable?.abort?.();
      } catch {
        // The browser may have already closed the failed stream.
      }
      // Do not lose a recording because the selected file became unwritable.
      downloadBlob(blob, options.fileName);
      return { method: "download", fileName: options.fileName };
    }
  }

  downloadBlob(blob, options.fileName);
  return { method: "download", fileName: options.fileName };
}

export class WhiteboardRecorder {
  private callbacks: RecordingCallbacks;
  private status: RecordingStatus = "idle";
  private mediaRecorder: MediaRecorder | null = null;
  private sourceStream: MediaStream | null = null;
  private userMediaStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private sourceVideo: HTMLVideoElement | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private sourceCanvas: HTMLCanvasElement | null = null;
  private compositorCanvas: HTMLCanvasElement | null = null;
  private compositorContext: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private animationFrame: number | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedAt = 0;
  private totalPausedMs = 0;
  private mimeType = "";
  private stopResolution: StopResolution | null = null;
  private overlay: WebcamOverlayOptions = DEFAULT_WEBCAM;
  private frameRate = 30;
  private lastDrawAt = 0;
  private disposed = false;
  private sourceEndedHandler: (() => void) | null = null;
  private toolRail: RecordingToolRailOptions | null = null;
  private toolRailRenderWidth = 0;
  private cameraOverlayInSource = false;

  constructor(callbacks: RecordingCallbacks = {}) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: RecordingCallbacks): void {
    this.callbacks = callbacks;
  }

  getStatus(): RecordingStatus {
    return this.status;
  }

  getMimeType(): string {
    return this.mimeType;
  }

  getElapsedMs(): number {
    if (!this.startedAt) return 0;
    const end = this.pausedAt || now();
    return Math.max(0, end - this.startedAt - this.totalPausedMs);
  }

  getPreviewStream(): MediaStream | null {
    return this.outputStream;
  }

  updateWebcamOverlay(webcam: Partial<WebcamOverlayOptions>): void {
    this.overlay = { ...this.overlay, ...webcam };
    if (this.status === "previewing") this.drawFrame();
  }

  updateToolRail(toolRail?: RecordingToolRailOptions): void {
    this.toolRail = toolRail ? { ...toolRail, items: [...toolRail.items] } : null;
    if (this.status === "previewing") this.drawFrame();
  }

  private setStatus(status: RecordingStatus): void {
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }

  private reportError(error: unknown): Error {
    const value = asError(error);
    this.setStatus("error");
    this.callbacks.onError?.(value);
    return value;
  }

  async prepare(options: RecordingStartOptions = {}): Promise<RecordingPreview> {
    if (["preparing", "recording", "paused", "stopping"].includes(this.status)) {
      throw new Error("A recording is already active.");
    }
    if (!isRecordingSupported()) {
      throw this.reportError(
        new Error("This browser does not provide the required recording APIs."),
      );
    }

    this.disposed = false;
    this.releaseResources();
    this.chunks = [];
    this.startedAt = 0;
    this.pausedAt = 0;
    this.totalPausedMs = 0;
    this.frameRate = Math.min(60, Math.max(12, options.frameRate ?? 30));
    this.overlay = { ...DEFAULT_WEBCAM, ...options.webcam };
    this.cameraOverlayInSource = options.captureMode === "screen";
    this.toolRail = options.toolRail ? { ...options.toolRail, items: [...options.toolRail.items] } : null;
    this.mimeType = selectRecordingMimeType(options.preferredMimeTypes);
    this.setStatus("preparing");

    try {
      await this.acquireBoardSource(options);
      await this.acquireUserMedia(options);
      this.prepareCompositor(options);
      await this.prepareAudioMix(options.includeDisplayAudio ?? false);
      this.startCompositorLoop();
      if (!this.outputStream || !this.compositorCanvas) {
        throw new Error("The recording preview could not be created.");
      }
      this.setStatus("previewing");
      return {
        stream: this.outputStream,
        cameraStream: this.userMediaStream?.getVideoTracks().length
          ? new MediaStream(this.userMediaStream.getVideoTracks())
          : undefined,
        width: this.compositorCanvas.width,
        height: this.compositorCanvas.height,
      };
    } catch (error) {
      this.releaseResources();
      throw this.reportError(error);
    }
  }

  async start(options: RecordingStartOptions = {}): Promise<void> {
    if (["preparing", "recording", "paused", "stopping"].includes(this.status)) {
      throw new Error("A recording is already active.");
    }

    if (this.status !== "previewing") {
      await this.prepare(options);
    } else {
      this.overlay = { ...this.overlay, ...options.webcam };
      this.updateToolRail(options.toolRail);
    }

    try {
      this.mimeType = selectRecordingMimeType(options.preferredMimeTypes);
      this.createMediaRecorder(options.videoBitsPerSecond);
      this.pausedAt = 0;
      this.totalPausedMs = 0;
      this.chunks = [];
      this.setStatus("recording");
      // Give React two paints to collapse the studio and mount the presenter
      // self-view before the first recorded frame is encoded.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const recorder = this.mediaRecorder;
      if (!recorder || this.status !== "recording") return;
      this.startedAt = now();
      recorder.start(1_000);
    } catch (error) {
      this.releaseResources();
      throw this.reportError(error);
    }
  }

  cancelPreview(): void {
    if (this.status !== "previewing" && this.status !== "error") return;
    this.releaseResources();
    this.chunks = [];
    this.startedAt = 0;
    this.pausedAt = 0;
    this.totalPausedMs = 0;
    this.setStatus("idle");
  }

  private async acquireBoardSource(options: RecordingStartOptions): Promise<void> {
    const candidate = options.captureMode === "screen" ? null : options.sourceCanvas;
    if (
      candidate &&
      candidate.width > 0 &&
      candidate.height > 0 &&
      typeof candidate.captureStream === "function"
    ) {
      try {
        this.sourceCanvas = candidate;
        this.sourceStream = candidate.captureStream(this.frameRate);
        return;
      } catch {
        this.sourceCanvas = null;
        stopStream(this.sourceStream);
        this.sourceStream = null;
        // A tainted or browser-incompatible board can still be screen-captured.
      }
    }

    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error(
        "No recordable board canvas was provided, and this browser cannot share a screen or window.",
      );
    }

    const displayOptions = {
      video: {
        displaySurface: "browser",
        frameRate: { ideal: this.frameRate, max: this.frameRate },
      },
      audio: options.includeDisplayAudio ?? false,
      // Chromium uses these hints to put the current CanvasRoom tab first.
      // Other browsers safely ignore unsupported display-capture hints.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions;
    this.sourceStream = await navigator.mediaDevices.getDisplayMedia(
      displayOptions,
    );
    const videoTrack = this.sourceStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("The selected screen did not provide video.");

    this.sourceVideo = createMutedVideo(this.sourceStream);
    await waitForVideo(this.sourceVideo);
    this.sourceEndedHandler = () => {
      if (this.status === "previewing") {
        this.cancelPreview();
        return;
      }
      if (this.status !== "recording" && this.status !== "paused") return;
      void this.stop()
        .then((result) => this.callbacks.onSourceEnded?.(result))
        .catch((error) => this.callbacks.onError?.(asError(error)));
    };
    videoTrack.addEventListener("ended", this.sourceEndedHandler, { once: true });
  }

  private async acquireUserMedia(options: RecordingStartOptions): Promise<void> {
    if (!options.includeMicrophone && !options.includeCamera) return;

    const audio: boolean | MediaTrackConstraints = options.includeMicrophone
      ? options.microphoneDeviceId
        ? { deviceId: { exact: options.microphoneDeviceId }, echoCancellation: true }
        : { echoCancellation: true, noiseSuppression: true }
      : false;
    const video: boolean | MediaTrackConstraints = options.includeCamera
      ? options.cameraDeviceId
        ? { deviceId: { exact: options.cameraDeviceId } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } }
      : false;

    this.userMediaStream = await navigator.mediaDevices.getUserMedia({ audio, video });
    if (options.includeCamera) {
      this.cameraVideo = createMutedVideo(
        new MediaStream(this.userMediaStream.getVideoTracks()),
      );
      await waitForVideo(this.cameraVideo);
    }
  }

  private prepareCompositor(options: RecordingStartOptions): void {
    const sourceTrack = this.sourceStream?.getVideoTracks()[0];
    const settings = sourceTrack?.getSettings();
    const sourceWidth =
      this.sourceCanvas?.width || this.sourceVideo?.videoWidth || settings?.width || 1920;
    const sourceHeight =
      this.sourceCanvas?.height || this.sourceVideo?.videoHeight || settings?.height || 1080;
    const sourceCssWidth = this.sourceCanvas?.clientWidth || sourceWidth;
    const sourcePixelRatio = sourceWidth / Math.max(1, sourceCssWidth);
    const toolRailSourceWidth = this.toolRail
      ? Math.max(36, this.toolRail.width ?? 58) * sourcePixelRatio
      : 0;
    const totalSourceWidth = sourceWidth + toolRailSourceWidth;
    const dimensions = fitWithin(
      totalSourceWidth,
      sourceHeight,
      options.maxWidth ?? 1920,
      options.maxHeight ?? 1080,
    );

    this.compositorCanvas = document.createElement("canvas");
    this.compositorCanvas.width = dimensions.width;
    this.compositorCanvas.height = dimensions.height;
    this.toolRailRenderWidth = toolRailSourceWidth > 0
      ? Math.max(1, Math.round(dimensions.width * toolRailSourceWidth / totalSourceWidth))
      : 0;
    this.compositorContext = this.compositorCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!this.compositorContext) {
      throw new Error("The browser could not create the recording compositor.");
    }

    this.outputStream = this.compositorCanvas.captureStream(this.frameRate);
  }

  private async prepareAudioMix(includeDisplayAudio: boolean): Promise<void> {
    if (!this.outputStream) return;

    const audioTracks = [
      ...(this.userMediaStream?.getAudioTracks() ?? []),
      ...(includeDisplayAudio ? this.sourceStream?.getAudioTracks() ?? [] : []),
    ];
    if (audioTracks.length === 0) return;
    if (audioTracks.length === 1) {
      this.outputStream.addTrack(audioTracks[0]);
      return;
    }

    try {
      this.audioContext = new AudioContext();
      const destination = this.audioContext.createMediaStreamDestination();
      for (const track of audioTracks) {
        const source = this.audioContext.createMediaStreamSource(
          new MediaStream([track]),
        );
        source.connect(destination);
      }
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      destination.stream.getAudioTracks().forEach((track) => {
        this.outputStream?.addTrack(track);
      });
    } catch {
      // A single microphone track is preferable to failing recording entirely.
      this.outputStream.addTrack(audioTracks[0]);
    }
  }

  private startCompositorLoop(): void {
    const draw = (timestamp: number) => {
      if (!this.compositorCanvas || !this.compositorContext) return;
      const minimumInterval = 1_000 / this.frameRate;
      if (timestamp - this.lastDrawAt >= minimumInterval - 1) {
        this.lastDrawAt = timestamp;
        this.drawFrame();
      }
      this.animationFrame = requestAnimationFrame(draw);
    };
    this.drawFrame();
    this.animationFrame = requestAnimationFrame(draw);
  }

  private drawFrame(): void {
    const canvas = this.compositorCanvas;
    const context = this.compositorContext;
    if (!canvas || !context) return;

    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const boardX = this.toolRailRenderWidth;
    const boardWidth = Math.max(1, canvas.width - boardX);
    if (this.toolRail && this.toolRailRenderWidth > 0) {
      drawRecordingToolRail(
        context,
        this.toolRail,
        this.toolRailRenderWidth,
        canvas.height,
      );
    }

    if (this.sourceCanvas) {
      drawContained(
        context,
        this.sourceCanvas,
        this.sourceCanvas.width,
        this.sourceCanvas.height,
        boardWidth,
        canvas.height,
        boardX,
      );
    } else if (this.sourceVideo && this.sourceVideo.readyState >= 2) {
      drawContained(
        context,
        this.sourceVideo,
        this.sourceVideo.videoWidth,
        this.sourceVideo.videoHeight,
        boardWidth,
        canvas.height,
        boardX,
      );
    }
    context.restore();

    if (
      this.cameraVideo &&
      this.cameraVideo.readyState >= 2 &&
      !this.cameraOverlayInSource
    ) {
      this.drawWebcamOverlay(context, canvas.width, canvas.height);
    }
  }

  private drawWebcamOverlay(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    if (!this.cameraVideo) return;

    const ratios: Record<WebcamSize, number> = {
      small: 0.16,
      medium: 0.22,
      large: 0.29,
    };
    const margin = Math.max(8, this.overlay.margin ?? DEFAULT_WEBCAM.margin!);
    const contentLeft = this.toolRailRenderWidth;
    const contentWidth = Math.max(1, width - contentLeft);
    const size = Math.round(
      Math.min(
        Math.max(96, contentWidth * ratios[this.overlay.size]),
        contentWidth - margin * 2,
        height - margin * 2,
        height * 0.46,
      ),
    );
    const left = this.overlay.position.endsWith("left");
    const top = this.overlay.position.startsWith("top");
    const x = left ? contentLeft + margin : width - size - margin;
    const y = top ? margin : height - size - margin;

    context.save();
    context.shadowColor = "rgba(15, 23, 42, 0.28)";
    context.shadowBlur = Math.max(10, size * 0.06);
    context.shadowOffsetY = Math.max(4, size * 0.025);
    context.beginPath();
    if (this.overlay.shape === "circle") {
      context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      context.rect(x, y, size, size);
    }
    context.fillStyle = "#ffffff";
    context.fill();
    context.clip();

    if (this.overlay.mirror) {
      context.translate(x * 2 + size, 0);
      context.scale(-1, 1);
    }
    drawVideoCover(context, this.cameraVideo, x, y, size);
    context.restore();

    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.96)";
    context.lineWidth = Math.max(3, size * 0.018);
    context.beginPath();
    if (this.overlay.shape === "circle") {
      context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      context.rect(x, y, size, size);
    }
    context.stroke();
    context.restore();
  }

  private createMediaRecorder(videoBitsPerSecond?: number): void {
    if (!this.outputStream) throw new Error("The recording output is not ready.");

    const recorderOptions: MediaRecorderOptions = {};
    if (this.mimeType) recorderOptions.mimeType = this.mimeType;
    if (videoBitsPerSecond) {
      recorderOptions.videoBitsPerSecond = videoBitsPerSecond;
    }

    this.mediaRecorder = new MediaRecorder(this.outputStream, recorderOptions);
    // The recorder may select a more specific MIME when no candidate was given.
    this.mimeType = this.mediaRecorder.mimeType || this.mimeType || "video/webm";
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.mediaRecorder.onerror = (event) => {
      const possibleError = (event as Event & { error?: unknown }).error;
      const error = this.reportError(possibleError ?? "The media encoder failed.");
      this.stopResolution?.reject(error);
      this.stopResolution = null;
      this.releaseResources();
    };
    this.mediaRecorder.onstop = () => this.finishStop();
  }

  pause(): void {
    if (this.status !== "recording" || this.mediaRecorder?.state !== "recording") {
      return;
    }
    this.mediaRecorder.pause();
    this.pausedAt = now();
    this.setStatus("paused");
  }

  resume(): void {
    if (this.status !== "paused" || this.mediaRecorder?.state !== "paused") return;
    this.mediaRecorder.resume();
    if (this.pausedAt) this.totalPausedMs += now() - this.pausedAt;
    this.pausedAt = 0;
    this.setStatus("recording");
  }

  stop(): Promise<RecordingResult> {
    if (!this.mediaRecorder || !["recording", "paused"].includes(this.status)) {
      return Promise.reject(new Error("There is no active recording to stop."));
    }
    if (this.stopResolution) {
      return Promise.reject(new Error("The recording is already being stopped."));
    }

    if (this.pausedAt) {
      this.totalPausedMs += now() - this.pausedAt;
      this.pausedAt = 0;
    }
    this.setStatus("stopping");
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;

    let rejectStop: (error: Error) => void = () => undefined;
    const result = new Promise<RecordingResult>((resolve, reject) => {
      rejectStop = reject;
      this.stopResolution = { resolve, reject };
    });

    try {
      if (this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.requestData();
        this.mediaRecorder.stop();
      } else {
        this.finishStop();
      }
    } catch (error) {
      const value = this.reportError(error);
      rejectStop(value);
      this.stopResolution = null;
      this.releaseResources();
    }
    return result;
  }

  /** End an active recording immediately without creating or saving a file. */
  cancel(): void {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
      try {
        if (this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
      } catch {
        // Tracks and the encoder are released below even if stop() races.
      }
    }
    this.stopResolution?.reject(new Error("Recording was discarded."));
    this.stopResolution = null;
    this.releaseResources();
    this.chunks = [];
    this.startedAt = 0;
    this.pausedAt = 0;
    this.totalPausedMs = 0;
    this.setStatus("idle");
  }

  private finishStop(): void {
    const durationMs = this.getElapsedMs();
    const mimeType = this.mimeType || this.chunks[0]?.type || "video/webm";
    const result: RecordingResult = {
      blob: new Blob(this.chunks, { type: mimeType }),
      mimeType,
      durationMs,
      suggestedFileName: createRecordingFileName(mimeType),
    };
    const resolution = this.stopResolution;
    this.stopResolution = null;
    this.releaseResources();
    this.setStatus("idle");
    resolution?.resolve(result);
  }

  /** Stop tracks without producing or downloading a file. */
  dispose(): void {
    this.disposed = true;
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
      try {
        if (this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
      } catch {
        // Tracks are still stopped below.
      }
    }
    this.stopResolution?.reject(new Error("Recording was cancelled."));
    this.stopResolution = null;
    this.releaseResources();
    this.status = "idle";
  }

  private releaseResources(): void {
    if (this.animationFrame !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;

    const sourceTrack = this.sourceStream?.getVideoTracks()[0];
    if (sourceTrack && this.sourceEndedHandler) {
      sourceTrack.removeEventListener("ended", this.sourceEndedHandler);
    }
    this.sourceEndedHandler = null;

    stopStream(this.outputStream);
    stopStream(this.sourceStream);
    stopStream(this.userMediaStream);
    this.outputStream = null;
    this.sourceStream = null;
    this.userMediaStream = null;

    if (this.sourceVideo) this.sourceVideo.srcObject = null;
    if (this.cameraVideo) this.cameraVideo.srcObject = null;
    this.sourceVideo = null;
    this.cameraVideo = null;
    this.sourceCanvas = null;
    this.compositorCanvas = null;
    this.compositorContext = null;
    this.toolRail = null;
    this.toolRailRenderWidth = 0;
    this.cameraOverlayInSource = false;
    this.mediaRecorder = null;

    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close();
    }
    this.audioContext = null;
    this.lastDrawAt = 0;
    if (this.disposed) this.chunks = [];
  }
}
