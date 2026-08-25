import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where the API lives. Defaults to the same machine; set VITE_API_TARGET when the
// backend runs elsewhere, e.g. VITE_API_TARGET=http://192.168.1.42:4000
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Off Vite's default 5173 deliberately: that port is the first thing every
    // other Vite project on the machine takes, and a silent fallback to 5174
    // means you spend a while looking at somebody else's app. strictPort turns
    // a clash into a startup error instead.
    port: 5180,
    strictPort: true,
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
