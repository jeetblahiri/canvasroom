"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Camera,
  Circle as CircleIcon,
  Mic,
  Pause,
  Play,
  Save,
  Square as SquareIcon,
  type LucideIcon,
} from "lucide-react";
import {
  WhiteboardRecorder,
  createRecordingFileName,
  humanizeRecordingError,
  isRecordingSupported,
  requestRecordingSaveTarget,
  saveRecordingBlob,
  type RecordingResult,
  type RecordingSaveResult,
  type RecordingStatus,
  type WebcamPosition,
  type WebcamShape,
  type WebcamSize,
} from "@/lib/recording";

export interface RecordingPanelProps {
  /** A mounted board canvas is recorded without showing a screen-share dialog. */
  sourceCanvas?: HTMLCanvasElement | null;
  /** Useful when the canvas lives in a ref and can change between renders. */
  getSourceCanvas?: () => HTMLCanvasElement | null;
  className?: string;
  defaultMicrophoneEnabled?: boolean;
  defaultCameraEnabled?: boolean;
  onStatusChange?: (status: RecordingStatus) => void;
  onRecordingSaved?: (
    recording: RecordingResult,
    save: RecordingSaveResult,
  ) => void;
  onError?: (error: Error) => void;
}

const controlStyle: CSSProperties = {
  alignItems: "center",
  background: "#fff",
  border: "1px solid #ddd9cf",
  borderRadius: 10,
  color: "#282720",
  display: "flex",
  font: "inherit",
  gap: 8,
  minHeight: 38,
  padding: "8px 10px",
};

const labelStyle: CSSProperties = {
  color: "#6b685f",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.075em",
  margin: 0,
  textTransform: "uppercase",
};

const segmentedButtonStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "#68655d",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 650,
  minHeight: 30,
  padding: "5px 9px",
};

function formatElapsed(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}`;
}

function statusLabel(status: RecordingStatus, saving: boolean): string {
  if (saving) return "Saving";
  switch (status) {
    case "preparing":
      return "Preparing";
    case "recording":
      return "Recording";
    case "paused":
      return "Paused";
    case "stopping":
      return "Finishing";
    case "error":
      return "Needs attention";
    default:
      return "Ready";
  }
}

function Icon({
  name,
  size = 16,
}: {
  name: "record" | "pause" | "play" | "stop" | "mic" | "camera" | "save";
  size?: number;
}) {
  const icons: Record<typeof name, LucideIcon> = {
    camera: Camera,
    mic: Mic,
    pause: Pause,
    play: Play,
    record: CircleIcon,
    save: Save,
    stop: SquareIcon,
  };
  const Glyph = icons[name];
  return (
    <Glyph
      aria-hidden="true"
      fill={name === "record" || name === "stop" ? "currentColor" : "none"}
      size={size}
      strokeWidth={name === "record" || name === "stop" ? 0 : 1.8}
    />
  );
}

function ToggleRow({
  checked,
  disabled,
  icon,
  label,
  onChange,
  supportingText,
}: {
  checked: boolean;
  disabled?: boolean;
  icon: "mic" | "camera";
  label: string;
  onChange: (checked: boolean) => void;
  supportingText: string;
}) {
  return (
    <label
      style={{
        ...controlStyle,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.58 : 1,
        padding: "9px 10px",
      }}
    >
      <span
        style={{
          alignItems: "center",
          background: checked ? "#fbece8" : "#f2f0e9",
          borderRadius: 8,
          color: checked ? "#b83a28" : "#6e6b63",
          display: "flex",
          height: 32,
          justifyContent: "center",
          width: 32,
        }}
      >
        <Icon name={icon} />
      </span>
      <span style={{ display: "grid", flex: 1, gap: 1 }}>
        <span style={{ color: "#24231e", fontSize: 13, fontWeight: 700 }}>
          {label}
        </span>
        <span style={{ color: "#7a776f", fontSize: 11 }}>{supportingText}</span>
      </span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        style={{ accentColor: "#d94c37", height: 17, width: 17 }}
        type="checkbox"
      />
    </label>
  );
}

export function RecordingPanel({
  sourceCanvas,
  getSourceCanvas,
  className,
  defaultMicrophoneEnabled = true,
  defaultCameraEnabled = true,
  onStatusChange,
  onRecordingSaved,
  onError,
}: RecordingPanelProps) {
  const recorderRef = useRef<WhiteboardRecorder | null>(null);
  const mountedRef = useRef(false);
  const callbackRef = useRef({ onStatusChange, onRecordingSaved, onError });

  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(
    defaultMicrophoneEnabled,
  );
  const [cameraEnabled, setCameraEnabled] = useState(defaultCameraEnabled);
  const [displayAudioEnabled, setDisplayAudioEnabled] = useState(false);
  const [webcamShape, setWebcamShape] = useState<WebcamShape>("circle");
  const [webcamPosition, setWebcamPosition] =
    useState<WebcamPosition>("bottom-right");
  const [webcamSize, setWebcamSize] = useState<WebcamSize>("medium");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    callbackRef.current = { onStatusChange, onRecordingSaved, onError };
  }, [onError, onRecordingSaved, onStatusChange]);

  useEffect(() => {
    mountedRef.current = true;
    const supportCheck = window.requestAnimationFrame(() => {
      if (mountedRef.current) setSupported(isRecordingSupported());
    });

    const handleSaved = async (recording: RecordingResult) => {
      if (mountedRef.current) setSaving(true);
      try {
        // Source-ended events do not carry a user gesture, so download is the
        // only cross-browser-safe destination at that point.
        const save = await saveRecordingBlob(recording.blob, {
          fileName: recording.suggestedFileName,
          target: { kind: "download" },
        });
        if (mountedRef.current) {
          setSaveMessage(`Saved ${save.fileName}`);
          callbackRef.current.onRecordingSaved?.(recording, save);
        }
      } catch (error) {
        const value = error instanceof Error ? error : new Error(String(error));
        if (mountedRef.current) setErrorMessage(humanizeRecordingError(value));
        callbackRef.current.onError?.(value);
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    };

    const recorder = new WhiteboardRecorder({
      onStatusChange: (nextStatus) => {
        if (mountedRef.current) setStatus(nextStatus);
        callbackRef.current.onStatusChange?.(nextStatus);
      },
      onError: (error) => {
        if (mountedRef.current) setErrorMessage(humanizeRecordingError(error));
        callbackRef.current.onError?.(error);
      },
      onSourceEnded: handleSaved,
    });
    recorderRef.current = recorder;

    return () => {
      window.cancelAnimationFrame(supportCheck);
      mountedRef.current = false;
      recorder.dispose();
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (status !== "recording" && status !== "paused") {
      return;
    }

    const update = () => setElapsedMs(recorderRef.current?.getElapsedMs() ?? 0);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  const busy =
    saving || status === "preparing" || status === "stopping";
  const active = status === "recording" || status === "paused";
  const settingsDisabled = busy || active;

  const start = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    setErrorMessage(null);
    setSaveMessage(null);
    setElapsedMs(0);
    try {
      await recorder.start({
        sourceCanvas: sourceCanvas ?? getSourceCanvas?.() ?? null,
        includeMicrophone: microphoneEnabled,
        includeCamera: cameraEnabled,
        includeDisplayAudio: displayAudioEnabled,
        frameRate: 30,
        maxWidth: 1920,
        maxHeight: 1080,
        videoBitsPerSecond: 6_000_000,
        webcam: {
          shape: webcamShape,
          position: webcamPosition,
          size: webcamSize,
          mirror: true,
        },
      });
    } catch (error) {
      // The recorder callback already reports most setup errors, but this also
      // covers misuse errors thrown before the browser capture flow starts.
      const value = error instanceof Error ? error : new Error(String(error));
      setErrorMessage(humanizeRecordingError(value));
    }
  }, [
    cameraEnabled,
    displayAudioEnabled,
    getSourceCanvas,
    microphoneEnabled,
    sourceCanvas,
    webcamPosition,
    webcamShape,
    webcamSize,
  ]);

  const stopAndSave = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || !active) return;

    setErrorMessage(null);
    setSaveMessage(null);
    setSaving(true);
    try {
      // Both operations are initiated synchronously from this click. That lets
      // Chromium keep the save picker user-activated while MediaRecorder emits
      // its final chunk in the background.
      const recordingPromise = recorder.stop();
      const mimeType = recorder.getMimeType() || "video/webm";
      const targetPromise = requestRecordingSaveTarget({
        suggestedFileName: createRecordingFileName(mimeType),
        mimeType,
      });
      const [recording, target] = await Promise.all([
        recordingPromise,
        targetPromise,
      ]);
      const save = await saveRecordingBlob(recording.blob, {
        fileName: recording.suggestedFileName,
        target,
      });
      if (mountedRef.current) {
        setSaveMessage(
          save.method === "file-system"
            ? `Saved to ${save.fileName}`
            : `Downloaded ${save.fileName}`,
        );
        callbackRef.current.onRecordingSaved?.(recording, save);
      }
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      if (mountedRef.current) setErrorMessage(humanizeRecordingError(value));
      callbackRef.current.onError?.(value);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [active]);

  const togglePause = useCallback(() => {
    if (status === "paused") recorderRef.current?.resume();
    else recorderRef.current?.pause();
  }, [status]);

  const hasDirectCanvas = Boolean(sourceCanvas || getSourceCanvas);
  const sourceDescription = hasDirectCanvas
    ? "Captures the whiteboard directly"
    : "Choose a tab, window, or screen when recording starts";

  const statusColor =
    status === "recording"
      ? "#d94c37"
      : status === "paused"
        ? "#d58b22"
        : errorMessage
          ? "#bd3e32"
          : "#548367";

  const shapeOptions = useMemo(
    () => [
      { value: "circle" as const, label: "Circle" },
      { value: "square" as const, label: "Square" },
    ],
    [],
  );

  return (
    <section
      aria-label="Record whiteboard"
      className={className}
      style={{
        background: "#fbfaf6",
        border: "1px solid #e4e0d6",
        borderRadius: 16,
        boxShadow: "0 16px 42px rgba(39, 35, 26, 0.12)",
        boxSizing: "border-box",
        color: "#24231e",
        fontFamily:
          "var(--font-sans), Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
        maxWidth: 360,
        padding: 14,
        width: "100%",
      }}
    >
      <header
        style={{
          alignItems: "center",
          display: "flex",
          gap: 10,
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div style={{ display: "grid", gap: 2 }}>
          <h2 style={{ fontSize: 15, lineHeight: 1.2, margin: 0 }}>Record board</h2>
          <span style={{ color: "#77736a", fontSize: 11 }}>
            {sourceDescription}
          </span>
        </div>
        <div
          aria-live="polite"
          style={{
            alignItems: "center",
            background: "#f1eee7",
            borderRadius: 999,
            color: "#5e5a52",
            display: "flex",
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 700,
            gap: 6,
            padding: "6px 8px",
          }}
        >
          <span
            style={{
              background: statusColor,
              borderRadius: "50%",
              boxShadow:
                status === "recording" ? `0 0 0 3px ${statusColor}26` : "none",
              height: 7,
              width: 7,
            }}
          />
          {statusLabel(status, saving)}
        </div>
      </header>

      {active || busy ? (
        <div
          style={{
            alignItems: "center",
            background: "#24231e",
            borderRadius: 12,
            color: "#fff",
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 12,
            padding: "11px 12px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
            <span
              style={{
                background: status === "paused" ? "#dfa13e" : "#e2543e",
                borderRadius: "50%",
                height: 9,
                width: 9,
              }}
            />
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 17,
                fontVariantNumeric: "tabular-nums",
                fontWeight: 700,
                letterSpacing: "0.035em",
              }}
            >
              {formatElapsed(elapsedMs)}
            </span>
          </div>
          <span style={{ color: "#bbb7af", fontSize: 10 }}>1080p · 30 fps</span>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        <ToggleRow
          checked={microphoneEnabled}
          disabled={settingsDisabled}
          icon="mic"
          label="Microphone"
          onChange={setMicrophoneEnabled}
          supportingText="Include your narration"
        />
        <ToggleRow
          checked={cameraEnabled}
          disabled={settingsDisabled}
          icon="camera"
          label="Camera overlay"
          onChange={setCameraEnabled}
          supportingText="Add a presenter bubble"
        />

        {!hasDirectCanvas ? (
          <label
            style={{
              alignItems: "center",
              color: "#6e6b63",
              cursor: settingsDisabled ? "not-allowed" : "pointer",
              display: "flex",
              fontSize: 12,
              gap: 8,
              opacity: settingsDisabled ? 0.58 : 1,
              padding: "2px 3px",
            }}
          >
            <input
              checked={displayAudioEnabled}
              disabled={settingsDisabled}
              onChange={(event) => setDisplayAudioEnabled(event.target.checked)}
              style={{ accentColor: "#d94c37" }}
              type="checkbox"
            />
            Include shared tab/system audio when available
          </label>
        ) : null}
      </div>

      {cameraEnabled ? (
        <div
          aria-label="Camera overlay settings"
          style={{
            borderTop: "1px solid #e4e0d6",
            display: "grid",
            gap: 10,
            marginTop: 13,
            paddingTop: 12,
          }}
        >
          <p style={labelStyle}>Camera appearance</p>
          <div
            style={{
              ...controlStyle,
              background: "#efede6",
              border: 0,
              gap: 2,
              padding: 4,
            }}
          >
            {shapeOptions.map((option) => {
              const selected = webcamShape === option.value;
              return (
                <button
                  aria-pressed={selected}
                  disabled={settingsDisabled}
                  key={option.value}
                  onClick={() => setWebcamShape(option.value)}
                  style={{
                    ...segmentedButtonStyle,
                    background: selected ? "#fff" : "transparent",
                    boxShadow: selected
                      ? "0 1px 3px rgba(35, 32, 24, 0.12)"
                      : "none",
                    color: selected ? "#24231e" : "#747169",
                    flex: 1,
                    opacity: settingsDisabled ? 0.55 : 1,
                  }}
                  type="button"
                >
                  {option.value === "circle" ? (
                    <CircleIcon
                      aria-hidden="true"
                      size={12}
                      style={{ marginRight: 6, verticalAlign: -2 }}
                    />
                  ) : (
                    <SquareIcon
                      aria-hidden="true"
                      size={12}
                      style={{ marginRight: 6, verticalAlign: -2 }}
                    />
                  )}
                  {option.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
            <label style={{ display: "grid", gap: 5 }}>
              <span style={labelStyle}>Corner</span>
              <select
                disabled={settingsDisabled}
                onChange={(event) =>
                  setWebcamPosition(event.target.value as WebcamPosition)
                }
                style={{
                  ...controlStyle,
                  appearance: "auto",
                  opacity: settingsDisabled ? 0.55 : 1,
                  width: "100%",
                }}
                value={webcamPosition}
              >
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 5 }}>
              <span style={labelStyle}>Size</span>
              <select
                disabled={settingsDisabled}
                onChange={(event) => setWebcamSize(event.target.value as WebcamSize)}
                style={{
                  ...controlStyle,
                  appearance: "auto",
                  opacity: settingsDisabled ? 0.55 : 1,
                  width: "100%",
                }}
                value={webcamSize}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
          </div>
        </div>
      ) : null}

      {!supported ? (
        <p
          role="alert"
          style={{ color: "#a83c31", fontSize: 12, lineHeight: 1.45, margin: "12px 2px 0" }}
        >
          This browser cannot record media. Try the latest Chrome, Edge, or Safari.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          role="alert"
          style={{
            background: "#fff0ec",
            border: "1px solid #f0c7bf",
            borderRadius: 9,
            color: "#963528",
            fontSize: 12,
            lineHeight: 1.45,
            margin: "12px 0 0",
            padding: "8px 10px",
          }}
        >
          {errorMessage}
        </p>
      ) : null}
      {saveMessage && !errorMessage ? (
        <p
          aria-live="polite"
          style={{
            alignItems: "center",
            color: "#47755a",
            display: "flex",
            fontSize: 12,
            gap: 6,
            margin: "12px 2px 0",
          }}
        >
          <Icon name="save" size={15} />
          {saveMessage}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {!active ? (
          <button
            disabled={!supported || busy}
            onClick={() => void start()}
            style={{
              alignItems: "center",
              background: busy ? "#e4b1a8" : "#d94c37",
              border: 0,
              borderRadius: 10,
              color: "#fff",
              cursor: !supported || busy ? "not-allowed" : "pointer",
              display: "flex",
              flex: 1,
              font: "inherit",
              fontSize: 13,
              fontWeight: 750,
              gap: 8,
              justifyContent: "center",
              minHeight: 42,
              padding: "9px 13px",
            }}
            type="button"
          >
            <Icon name="record" />
            {saving ? "Saving…" : status === "preparing" ? "Preparing…" : "Start recording"}
          </button>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={togglePause}
              style={{
                ...controlStyle,
                cursor: busy ? "not-allowed" : "pointer",
                flex: 1,
                fontSize: 13,
                fontWeight: 700,
                justifyContent: "center",
              }}
              type="button"
            >
              <Icon name={status === "paused" ? "play" : "pause"} />
              {status === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              disabled={busy}
              onClick={() => void stopAndSave()}
              style={{
                ...controlStyle,
                background: "#24231e",
                borderColor: "#24231e",
                color: "#fff",
                cursor: busy ? "not-allowed" : "pointer",
                flex: 1,
                fontSize: 13,
                fontWeight: 700,
                justifyContent: "center",
              }}
              type="button"
            >
              <Icon name="stop" />
              Stop &amp; save
            </button>
          </>
        )}
      </div>

      <p
        style={{
          color: "#8a867d",
          fontSize: 10,
          lineHeight: 1.45,
          margin: "9px 2px 0",
          textAlign: "center",
        }}
      >
        Your browser asks before using the screen, camera, or microphone.
      </p>
    </section>
  );
}

export default RecordingPanel;
