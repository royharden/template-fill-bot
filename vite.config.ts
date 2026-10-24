import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The inner repo root (the folder that holds this file). The dev server may serve files from here only:
// never the outer planning shell, never any .thinking folder.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      strict: true,
      allow: [repoRoot],
    },
  },
});
