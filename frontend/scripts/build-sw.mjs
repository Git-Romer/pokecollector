// Post-build step: turns src/sw/sw.js into dist/sw.real.js and dist/sw.js with the precache
// manifest and BUILD_ID filled in, and copies the kill worker (design §6.3.1).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUDGET_BYTES = 12 * 1024 * 1024
const FIXED_FILES = [
  'pokeball.svg', 'cardback.jpg', 'favicon.ico', 'favicon-48.png',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.json',
]

const sha256 = data => createHash('sha256').update(data).digest('hex')

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

export function buildServiceWorker({ distDir, swSource, killSource, budgetBytes = BUDGET_BYTES }) {
  const urlOf = file => '/' + relative(distDir, file).split(sep).join('/')
  const files = new Map()
  for (const file of walk(join(distDir, 'assets'))) {
    if (!file.endsWith('.map')) files.set(urlOf(file), file)
  }
  for (const name of FIXED_FILES) {
    const file = join(distDir, name)
    if (existsSync(file)) files.set('/' + name, file)
  }
  for (const file of walk(join(distDir, 'icons'))) files.set(urlOf(file), file)

  let totalBytes = 0
  const entries = [...files.keys()].sort().map(url => {
    const data = readFileSync(files.get(url))
    totalBytes += data.length
    return { url, revision: url.startsWith('/assets/') ? null : sha256(data).slice(0, 16) }
  })
  if (totalBytes > budgetBytes) {
    throw new Error(`Precache is ${totalBytes} bytes, over the ${budgetBytes} byte budget`)
  }

  const source = readFileSync(swSource, 'utf8')
  const buildId = sha256(JSON.stringify(entries) + sha256(source)).slice(0, 12)
  const replaceOnce = (text, token, value) => {
    if (text.split(token).length !== 2) throw new Error(`Placeholder ${token} must appear exactly once`)
    return text.replace(token, () => value)
  }
  let output = replaceOnce(source, "'__BUILD_ID__'", JSON.stringify(buildId))
  output = replaceOnce(output, '/*__PRECACHE__*/ []', JSON.stringify(entries))
  // __PC_..__ names (test hooks) are allowed; any other __TOKEN__ means a missed placeholder.
  if (/__[A-Z][A-Z0-9_]*__/.test(output.replace(/__PC_[A-Z0-9_]+__/g, ''))) {
    throw new Error('A __ placeholder token remains in the generated service worker')
  }

  writeFileSync(join(distDir, 'sw.real.js'), output)
  writeFileSync(join(distDir, 'sw.js'), output)
  copyFileSync(killSource, join(distDir, 'sw.kill.js'))
  return { buildId, entries, totalBytes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..')
  try {
    const { buildId, entries, totalBytes } = buildServiceWorker({
      distDir: join(root, 'dist'),
      swSource: join(root, 'src', 'sw', 'sw.js'),
      killSource: join(root, 'src', 'sw', 'sw.kill.js'),
    })
    console.log(`Service worker ${buildId}: ${entries.length} precache entries, ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MiB of 12 MiB)`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
