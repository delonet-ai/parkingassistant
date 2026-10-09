import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The API is reached through this app's own server in production (same origin, /api/*),
// so dev proxies the same prefix to a running API and nothing in the app knows a host.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: process.env.API_BASE_URL || 'http://127.0.0.1:3330',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
  test: {
    environment: 'happy-dom',
    globals: true
  }
})
