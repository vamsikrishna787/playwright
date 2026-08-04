import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where the API lives. Defaults to the same machine; set VITE_API_TARGET when the
// backend runs elsewhere, e.g. VITE_API_TARGET=http://192.168.1.42:3001
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on every interface so the dev server is reachable from other
    // machines on the network, not just localhost.
    host: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
