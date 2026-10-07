import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served from https://opensuperlab.com/labs/browserautomationlab/ (CloudFront -> S3 website).
// Override with VITE_BASE_PATH for another location.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: env.VITE_BASE_PATH || '/labs/browserautomationlab/',
    plugins: [react()],
    build: { outDir: 'dist', sourcemap: false },
  };
});
