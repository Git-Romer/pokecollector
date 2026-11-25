import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildServiceWorker } from './build-sw.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const swSource = join(root, 'src', 'sw', 'sw.js')
const killSource = join(root, 'src', 'sw', 'sw.kill.js')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pokecollector-build-sw-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, 'icons'))
  writeFileSync(join(dir, 'assets', 'index-AAA.js'), 'console.log(1)')
  writeFileSync(join(dir, 'assets', 'index-AAA.css'), 'body{}')
  writeFileSync(join(dir, 'assets', 'index-AAA.js.map'), '{}')
  writeFileSync(join(dir, 'icons', 'pc-192-v3.png'), 'png')
  for (const name of ['pokeball.svg', 'cardback.jpg', 'favicon.ico', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.json']) {
    writeFileSync(join(dir, name), name)
  }
  for (const name of ['index.html', 'index.html.template', 'robots.txt', 'robots-block.txt', 'robots-allow.txt', 'pokemon-logo.svg']) {
    writeFileSync(join(dir, name), name)
  }
  return dir
}

test('manifest lists assets and fixed statics and excludes HTML, robots, maps and workers', () => {
  const dir = fixture()
  try {
    const { entries } = buildServiceWorker({ distDir: dir, swSource, killSource })
    const urls = entries.map(entry => entry.url)
    assert.deepEqual(urls, [
      '/apple-touch-icon.png', '/assets/index-AAA.css', '/assets/index-AAA.js', '/cardback.jpg',
      '/favicon-48.png', '/favicon.ico', '/icon-192.png', '/icon-512.png', '/icons/pc-192-v3.png',
      '/manifest.json', '/pokeball.svg',
    ])
    assert.equal(entries.find(entry => entry.url === '/assets/index-AAA.js').revision, null)
    assert.match(entries.find(entry => entry.url === '/manifest.json').revision, /^[0-9a-f]{16}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes sw.js identical to sw.real.js, copies the kill worker, replaces placeholders once', () => {
  const dir = fixture()
  try {
    const { buildId } = buildServiceWorker({ distDir: dir, swSource, killSource })
    const real = readFileSync(join(dir, 'sw.real.js'), 'utf8')
    assert.equal(readFileSync(join(dir, 'sw.js'), 'utf8'), real)
    assert.equal(readFileSync(join(dir, 'sw.kill.js'), 'utf8'), readFileSync(killSource, 'utf8'))
    assert.match(buildId, /^[0-9a-f]{12}$/)
    assert.ok(real.includes(`const BUILD_ID = "${buildId}"`))
    assert.ok(!real.includes('__BUILD_ID__') && !real.includes('__PRECACHE__'))
    assert.doesNotMatch(real, /\bimport\s/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the build id changes when an asset is added and is stable otherwise', () => {
  const dir = fixture()
  try {
    const first = buildServiceWorker({ distDir: dir, swSource, killSource }).buildId
    assert.equal(buildServiceWorker({ distDir: dir, swSource, killSource }).buildId, first)
    writeFileSync(join(dir, 'assets', 'chunk-BBB.js'), 'x')
    assert.notEqual(buildServiceWorker({ distDir: dir, swSource, killSource }).buildId, first)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails above the precache budget', () => {
  const dir = fixture()
  try {
    assert.throws(
      () => buildServiceWorker({ distDir: dir, swSource, killSource, budgetBytes: 10 }),
      /over the 10 byte budget/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails when a placeholder is missing or duplicated or another token remains', () => {
  const dir = fixture()
  const scratch = mkdtempSync(join(tmpdir(), 'pokecollector-build-sw-src-'))
  try {
    const source = readFileSync(swSource, 'utf8')
    const bad = (name, text) => {
      const file = join(scratch, name)
      writeFileSync(file, text)
      return file
    }
    assert.throws(() => buildServiceWorker({ distDir: dir, killSource, swSource: bad('a.js', source.replace("'__BUILD_ID__'", "'x'")) }), /must appear exactly once/)
    assert.throws(() => buildServiceWorker({ distDir: dir, killSource, swSource: bad('b.js', `${source}\n// '__BUILD_ID__'`) }), /must appear exactly once/)
    assert.throws(() => buildServiceWorker({ distDir: dir, killSource, swSource: bad('c.js', `${source}\nconst X = '__OTHER__'`) }), /placeholder token remains/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})
