import { defineConfig } from 'vite'

// In dev the backend runs on :8787; proxy /api so the WebView/simulator sees one origin.
export default defineConfig({
  server: { host: true, port: 5173, proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:8787' } },
  build: { target: 'esnext' },
})
