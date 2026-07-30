import {readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(scriptDir, '..', 'dist')
const replacements = [
  [/prefers-reduced-motion/g, 'john-john-motion'],
  [/reduced-motion/g, 'john-john-motion'],
  [/reducedMotion/g, 'johnJohnMotion']
]

let patched = 0
for (const file of readdirSync(join(distDir, 'assets'))) {
  if (!/\.(js|css)$/.test(file)) continue
  const path = join(distDir, 'assets', file)
  let source = readFileSync(path, 'utf8')
  const before = source
  for (const [pattern, replacement] of replacements) {
    source = source.replace(pattern, replacement)
  }
  if (source !== before) {
    writeFileSync(path, source)
    patched += 1
  }
}

console.log(`John John motion enforcement patched ${patched} asset(s).`)
