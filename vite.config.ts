/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Vitest harness. Scope is deliberately narrow (see DEV note in the specs):
  // the audit-hardened *pure* logic — the dashboard number guards, the issued-qty
  // resolver, and the messaging search predicate. jsdom + RTL are wired so
  // component tests can be added later without re-tooling.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
  server: {
    // Workspace B (architecture restructure track) runs on :5174 so it can sit
    // alongside Workspace A (:5173) without a port collision.
    port: 5174,
    strictPort: true, // fail loudly if 5174 is taken — never silently fall back to 5175
    host: true,
    allowedHosts: ['localhost', '127.0.0.1'],
    // Dev proxy so the app can use RELATIVE api paths everywhere.
    //
    // Without this, the browser bundle had to be told an absolute API origin,
    // which meant that origin was compiled in at build time — a prod image
    // built without VITE_API_BASE_URL sent every user's browser to its OWN
    // localhost. Proxying here means dev matches production (nginx proxies the
    // same two paths), so `/api` and `/socket.io` are correct in both and
    // nothing about the server's address lives in the bundle.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**'],
    },
  },
})
