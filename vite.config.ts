import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The SPA builds straight into the Express server's static dir. The
// npm build script copies src/gui/public (docs.html) on top AFTER
// vite build — emptyOutDir here would wipe it if the order flipped.
export default defineConfig({
  root: 'src/gui/app',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/src/gui/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3737',
    },
  },
});
