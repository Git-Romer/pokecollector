import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCatalog, validateCatalog } from './translation-validation.mjs'

const localeRoot = fileURLToPath(new URL('../src/i18n/locales/', import.meta.url))
const en = parseCatalog(readFileSync(resolve(localeRoot, 'en.json'), 'utf8'))

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

for (const name of readdirSync(localeRoot).filter(name => name.endsWith('.json')).sort()) {
  try {
    const catalog = parseCatalog(readFileSync(resolve(localeRoot, name), 'utf8'))
    for (const error of validateCatalog(catalog, en)) errors.push(`${name}: ${error}`)
  } catch (error) {
    errors.push(`${name}: ${error.message}`)
  }
}

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
  console.error('\nEdit src/i18n/locales/*.json. Missing target-language keys may fall back to English; present translations must be non-empty and preserve placeholders.')
  process.exit(1)
}

console.log('Translation-key check passed.')
