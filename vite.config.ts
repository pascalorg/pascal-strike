import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    port: 5180,
    strictPort: true,
    // Playroom + WebGPU both want a secure context; localhost qualifies.
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['@recast-navigation/wasm'],
  },
})
