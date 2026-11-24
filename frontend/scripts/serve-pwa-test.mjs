// Test harness for tests/pwa: builds the app with the PWA default on, then serves dist/
// with vite preview on a fixed local port (design §9.2 P3 task 12).
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')

execSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_PWA_DEFAULT: 'on' },
})

const server = await preview({
  root,
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
})
server.printUrls()

const stop = () => server.httpServer.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
