import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete CanvasRoom workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /CanvasRoom/);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /CanvasRoom whiteboard/);
  assert.match(html, /Connect/);
  assert.match(html, /Media/);
  assert.match(html, /Record/);
  assert.match(html, /Board file/);
  assert.match(html, /Open/);
  assert.match(html, /New lecture/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("ships drawing, device, recording, persistence, and social-preview capabilities", async () => {
  const [canvas, device, recording, recordingPanel, whiteboardApp, boardFile, storage, packageJson, ogStats] = await Promise.all([
    readFile(new URL("../components/board/WhiteboardCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/device-link.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/recording.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/board/RecordingPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/board/WhiteboardApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/board-file.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-board-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    stat(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(canvas, /getCoalescedEvents/);
  assert.match(canvas, /isPenEraserGesture/);
  assert.match(canvas, /onStrokeEvent/);
  assert.match(canvas, /documentId/);
  assert.match(device, /RTCPeerConnection/);
  assert.match(device, /BroadcastChannel/);
  assert.match(recording, /MediaRecorder/);
  assert.match(recording, /captureStream/);
  assert.match(recording, /previewing/);
  assert.match(recording, /async prepare\(/);
  assert.match(recording, /drawRecordingToolRail/);
  assert.match(recording, /preferCurrentTab: true/);
  assert.match(recording, /audioBitsPerSecond/);
  assert.match(recording, /sampleRate: 48_000/);
  assert.match(recording, /kind: "cancelled"/);
  assert.match(recordingPanel, /recording-self-view/);
  assert.match(recordingPanel, /Discard now/);
  assert.match(whiteboardApp, /captureMode="screen"/);
  assert.match(boardFile, /\.canvasroom/);
  assert.match(boardFile, /dataUrl/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(storage, /listBoards/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.ok(ogStats.size > 50_000, "social preview should be a real generated image");

  await access(new URL("../public/sw.js", import.meta.url));
});
