import { defineConfig } from 'vite';

// The app imports the checks in ../core and the fictional samples in ../samples as they are.
// In development the relay (wrangler dev, port 8799) answers everything that is not a page file.
export default defineConfig({
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/v1': 'http://127.0.0.1:8799',
      '/attestation': 'http://127.0.0.1:8799',
      '/receipt': 'http://127.0.0.1:8799',
    },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  define: { global: 'globalThis' },
});
