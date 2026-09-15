import { defineConfig } from "vite";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export default defineConfig({
  plugins: [{ name: "local-pdf-resources", async closeBundle() {
    for (const directory of ["cmaps", "standard_fonts", "wasm"]) await cp(resolve(pdfjsRoot, directory), resolve("dist/pdfjs", directory), { recursive: true });
  } }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // Mermaid emits optional diagram engines up to ~690 KB. They load only after a
    // document uses that diagram type; warn if a future chunk exceeds that known ceiling.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(?:@codemirror|@lezer|crelt|style-mod|w3c-keyname)\//.test(id)) return "editor";
          if (/node_modules\/(?:yjs|y-protocols|y-indexeddb|y-codemirror\.next|lib0)\//.test(id)) {
            return "collaboration";
          }
          if (id.includes("node_modules/marked/")) return "markdown";
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:4321", "/sync": { target: "ws://127.0.0.1:4321", ws: true } } },
});
