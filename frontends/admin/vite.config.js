import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import process from 'node:process'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/admin/v1': {
        target: process.env.VITE_GATEWAY_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
