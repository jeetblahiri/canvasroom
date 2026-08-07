# CanvasRoom

CanvasRoom is a local-first connected whiteboard built for natural Pencil input, media-rich explanations, and recordings that combine the board, microphone, and a shaped presenter camera overlay.

## Included

- Pressure-sensitive freehand drawing with coalesced Pointer Events
- Shapes, text, selection, erasing, undo/redo, pan, and zoom
- Image, video, audio, PDF, file, and link attachments
- IndexedDB autosave plus portable board and PNG exports
- WebRTC iPad/peer linking with live stroke messages and BroadcastChannel fallback
- Canvas recording with mic, circular or square camera overlay, pause/resume, and local-file download
- Installable offline-capable PWA shell

## Local development

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm run build
npm run lint
npx tsc --noEmit
node --test tests/rendered-html.test.mjs
```
