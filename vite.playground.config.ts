import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'website/playground');

/**
 * Playground build (`npm run build:playground`) — bundles the
 * in-browser demo (src/gui/app/playground.html + sql.js WASM + seeded
 * demo data) into website/playground/ so Netlify serves it statically
 * at /playground/. Fully self-contained: the WASM binary is emitted as
 * a local asset, no CDN.
 *
 * The entry lives next to the real GUI's index.html so it shares the
 * app source; Vite names the emitted page after the entry file, so a
 * tiny plugin renames playground.html → index.html for clean
 * /playground/ URLs.
 */
const renameEntryHtml: Plugin = {
  name: 'calendrome:rename-playground-html',
  closeBundle() {
    renameSync(
      resolve(outDir, 'playground.html'),
      resolve(outDir, 'index.html'),
    );
  },
};

export default defineConfig({
  root: 'src/gui/app',
  base: '/playground/',
  plugins: [react(), renameEntryHtml],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/gui/app/playground.html'),
    },
  },
});
