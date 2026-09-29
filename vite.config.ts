import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Rule 2: Prevent exposing any environment variables to client bundle
  envPrefix: 'PUBLIC_SAFE_',
  build: {
    outDir: 'dist/client',
    // Rule 17: Disable source maps in production
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
