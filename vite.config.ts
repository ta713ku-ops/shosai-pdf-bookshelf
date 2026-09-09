import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, '.', 'VITE_').VITE_BASE_PATH || '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
}))
