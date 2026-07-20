import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

function readAppVersion() {
  try {
    return readFileSync(resolve(__dirname, '..', 'VERSION'), 'utf-8').trim()
  } catch {
    return packageJson.version
  }
}

export default defineConfig({
  plugins: [react()],
  // Components use the automatic JSX runtime and never import React. Vitest
  // does not pick that up from the plugin, so rendering any component in a
  // test failed with "React is not defined". Scoped to test runs: Vite's own
  // dev and build pipelines use oxc, which ignores this and warns about it.
  esbuild: process.env.VITEST ? { jsx: 'automatic', jsxImportSource: 'react' } : undefined,
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    globals: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
