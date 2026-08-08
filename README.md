# CanvasRoom

CanvasRoom is a local-first connected whiteboard built for natural Pencil input, media-rich explanations, and recordings that combine the board, microphone, and a shaped presenter camera overlay.

## Included

- Pressure-sensitive freehand drawing with coalesced Pointer Events
- Shapes, text, selection, erasing, undo/redo, pan, and zoom
- Persistent lecture tabs, each with its own infinite board, viewport, and attachments
- Image, video, audio, PDF, file, and link attachments
- IndexedDB autosave plus attachment-aware `.canvasroom` board documents and PNG exports
- WebRTC iPad/peer linking with live stroke messages and BroadcastChannel fallback
- Preflight recording preview for the complete visible CanvasRoom tab, including the real pen column and working media/open panels, plus a mirrored circular or square presenter self-view, compact pause/save/discard controls, and local-file saving
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

## GitHub Pages

The repository includes a separate static build that keeps all whiteboard data and media local to the browser:

```bash
npm run build:pages
```

The generated site is written to `dist-pages/`. The included GitHub Actions workflow builds and deploys that directory whenever `main` is pushed. In the repository settings, choose **GitHub Actions** as the Pages source. The resulting project URL is:

`https://jeetblahiri.github.io/canvasroom/`
