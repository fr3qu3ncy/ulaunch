import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8317' },
  },
})
