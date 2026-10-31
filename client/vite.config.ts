import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite serves the UI on :5173 and forwards API and WebSocket
// traffic to the Node server on :3000, so the browser sees one origin and
// the session cookie just works. In production Express serves both.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
