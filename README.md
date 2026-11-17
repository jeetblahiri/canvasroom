# CanvasRoom

CanvasRoom is a local-first connected whiteboard built for natural Pencil input, media-rich explanations, and recordings that combine the board, microphone, and a shaped presenter camera overlay.

## Included

- Pressure-sensitive Apple Pencil and Wacom drawing with coalesced events, tilt, palm rejection, and temporary barrel/eraser-end support
- Shapes, text, selection, erasing, undo/redo, pan, and zoom
- Persistent lecture tabs, each with its own infinite board, viewport, and attachments
- Image, video, audio, PDF, file, and link attachments
- IndexedDB autosave plus attachment-aware `.canvasroom` board documents and PNG exports
- WebRTC iPad/peer linking with live stroke messages and BroadcastChannel fallback
- Preflight recording preview for the complete visible CanvasRoom tab, including the real pen column and working media/open panels, plus a mirrored circular or square presenter self-view, 1080p60 video, high-bitrate 48 kHz narration/shared-audio mixing, compact pause/save/discard controls, and local-file saving
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


## Public discovery and offline boundaries

The Pages build includes a canonical application page, initial HTML introduction,
SoftwareApplication schema, sitemap and optional llms directory. Local boards and
recordings are never included. GitHub Pages cannot set project-specific HTTP
security headers, and robots.txt must live at the host root: adding
`/canvasroom/robots.txt` would not control crawlers. A dedicated Bodhi host would be
needed for independent HTTP/robots policy. The project sitemap can be submitted
under its verified Search Console URL prefix.

Pull requests now run the same artifact checks as releases. Only main deploys;
`release.json` identifies its exact source commit. Offline cache cleanup is scoped
to this app, private/API requests are not cached, and asset failures never return
an HTML document in place of JavaScript or media.
