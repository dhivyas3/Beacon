import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    // Keep the browser's Host header (no changeOrigin) so the API's Origin check accepts writes.
    proxy: { '/api': { target: apiTarget, changeOrigin: false, xfwd: true } },
  },
  build: { sourcemap: true },
});
