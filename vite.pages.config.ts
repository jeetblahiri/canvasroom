import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const projectRoot = process.cwd();
const requestedBase = process.env.GITHUB_PAGES_BASE_PATH ?? "/canvasroom/";
const base = requestedBase.endsWith("/") ? requestedBase : `${requestedBase}/`;

export default defineConfig({
  root: resolve(projectRoot, "github-pages"),
  base,
  publicDir: resolve(projectRoot, "public"),
  plugins: [react(), {
    name: "release-revision",
    generateBundle() {
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      this.emitFile({ type: "asset", fileName: "release.json", source: JSON.stringify({ commit }) + "\n" });
    },
  }],
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  build: {
    outDir: resolve(projectRoot, "dist-pages"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
});
