import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const pagesRoot = new URL("../dist-pages/", import.meta.url);

test("GitHub Pages artifact uses the canvasroom project base path", async () => {
  const html = await readFile(new URL("index.html", pagesRoot), "utf8");
  assert.match(html, /src="\/canvasroom\/assets\/[^"]+\.js"/);
  assert.match(html, /href="\/canvasroom\/assets\/[^"]+\.css"/);
  assert.match(html, /href="\/canvasroom\/manifest\.webmanifest"/);
  assert.doesNotMatch(html, /\/_next\//);
  assert.doesNotMatch(html, /localhost/);
});

test("GitHub Pages artifact includes its scoped PWA and social assets", async () => {
  const [manifest, serviceWorker, socialImage] = await Promise.all([
    readFile(new URL("manifest.webmanifest", pagesRoot), "utf8"),
    readFile(new URL("sw.js", pagesRoot), "utf8"),
    stat(new URL("og.png", pagesRoot)),
  ]);

  const parsed = JSON.parse(manifest);
  assert.equal(parsed.start_url, ".");
  assert.equal(parsed.scope, ".");
  assert.match(serviceWorker, /self\.registration\.scope/);
  assert.ok(socialImage.size > 50_000);
});
