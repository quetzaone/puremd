import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    strictPort: true,
    port: 1420
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2020"
  }
});
