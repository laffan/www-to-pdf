import { defineConfig } from "vite";

// For a GitHub Pages *project* site the app is served from
// https://<user>.github.io/<repo>/, so assets need that base path.
// The Pages deploy workflow sets BASE_PATH; local dev and the Tauri build
// use "/". Override by exporting BASE_PATH before running the build.
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  build: {
    outDir: "dist",
    target: "es2020",
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
