import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import en from '../src/i18n/en.js'

const frontendRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = resolve(frontendRoot, 'src')
const translationCall = /(?:^|[^\w$])t\s*\(\s*(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path)
    return ['.js', '.jsx'].includes(extname(entry.name)) ? [path] : []
  })
}

function resolveTranslation(path) {
  return path.split('.').reduce((value, part) => value?.[part], en)
}

const errors = []

for (const file of collectFiles(sourceRoot)) {
  const path = relative(sourceRoot, file).replaceAll('\\', '/')
  if (path.startsWith('i18n/') || path.endsWith('.test.js') || path.endsWith('.test.jsx')) continue

  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(translationCall)) {
    const key = match[2]
    if (typeof resolveTranslation(key) === 'string') continue

    const keyOffset = match.index + match[0].lastIndexOf(key)
    const line = source.slice(0, keyOffset).split('\n').length
    errors.push(`${path}:${line}: Missing English translation for "${key}".`)
  }
}

if (errors.length > 0) {
  console.error('Translation-key check failed:\n')
  for (const error of errors) console.error(`- ${error}`)
  console.error('\nAdd the key to src/i18n/en.js. Other languages may fall back to English until translated.')
  process.exit(1)
}

console.log('Translation-key check passed.')
