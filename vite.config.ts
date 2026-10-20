import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.DABO_DEMO_API_PORT || '4310');
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) {
  throw new Error('DABO_DEMO_API_PORT must be an integer between 1024 and 65535.');
}
const apiProxy = { '/api': `http://127.0.0.1:${apiPort}` };
export default defineConfig({
  root: path.join(root, 'client'),
  envDir: root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(root, 'client/src'),
      '@client': path.join(root, 'client'),
      '@shared': path.join(root, 'shared'),
    },
  },
  define: {
    'process.env.CLIENT_BASE_PATH': JSON.stringify('/'),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: path.join(root, 'dist/client'),
    emptyOutDir: true,
  },
});
