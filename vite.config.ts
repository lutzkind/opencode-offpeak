import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

// The Desktop GUI entry must be one prebuilt CommonJS file. The official
// preset compiles Solid JSX, inlines dynamic imports, and keeps the app's
// shared modules external so the bundle uses the host's instances.
export default defineConfig({
  plugins: [gui()],
});
