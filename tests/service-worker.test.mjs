import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
function worker({ offline = false, privateResponse = false } = {}) {
  const listeners = {}, deleted = [], writes = [];
  const cache = {
    keys: async () => [], delete: async () => true,
    put: async (request) => writes.push(request.url),
    match: async (request) => request === "/canvasroom/" ? new Response("saved shell", { headers: { "content-type": "text/html" } }) : undefined,
  };
  vm.runInNewContext(source, {
    URL, Response,
    self: { registration: { scope: "https://example.test/canvasroom/" }, location: { origin: "https://example.test" }, clients: { claim() {} }, skipWaiting() {}, addEventListener: (name, listener) => { listeners[name] = listener; } },
    caches: { open: async () => cache, keys: async () => ["another-app", "canvasroom-shell:/other/:v1", "canvasroom-shell:/canvasroom/:v1"], delete: async (name) => deleted.push(name) },
    fetch: async () => { if (offline) throw new Error("offline"); return new Response("asset", { headers: { "cache-control": privateResponse ? "private, no-store" : "public" } }); },
  });
  async function request(path, { mode = "cors", authorized = false } = {}) {
    let response; const pending = [];
    listeners.fetch({ request: { url: "https://example.test" + path, method: "GET", mode, headers: new Headers(authorized ? { authorization: "Bearer private" } : {}) }, respondWith(value) { response = value; }, waitUntil(value) { pending.push(value); } });
    const result = await response; await Promise.all(pending); return result;
  }
  return { listeners, deleted, writes, request };
}

test("activation preserves caches belonging to other projects on the shared host", async () => {
  const app = worker(); const pending = [];
  app.listeners.activate({ waitUntil: (value) => pending.push(value) }); await Promise.all(pending);
  assert.deepEqual(app.deleted, ["canvasroom-shell:/canvasroom/:v1"]);
});

test("offline failures never substitute HTML for assets or intercept private/unrelated requests", async () => {
  const app = worker({ offline: true });
  assert.equal(await app.request("/other/app.js"), undefined);
  assert.equal(await app.request("/canvasroom/api/boards"), undefined);
  assert.equal(await app.request("/canvasroom/secret.js", { authorized: true }), undefined);
  assert.equal((await app.request("/canvasroom/missing.js")).type, "error");
  assert.equal(await (await app.request("/canvasroom/", { mode: "navigate" })).text(), "saved shell");
});

test("successful static assets cache but private responses never do", async () => {
  const app = worker(); await app.request("/canvasroom/assets/app.js"); assert.equal(app.writes.length, 1);
  const privateApp = worker({ privateResponse: true }); await privateApp.request("/canvasroom/assets/app.js"); assert.equal(privateApp.writes.length, 0);
});
