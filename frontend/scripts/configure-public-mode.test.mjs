import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker-entrypoint.d', '40-configure-public-mode.sh')
const indexTemplate = '<!doctype html><html><head><title>Pokemon TCG Collection</title></head></html>\n'

function runEntrypoint(publicMode) {
  const webRoot = mkdtempSync(resolve(tmpdir(), 'pokecollector-public-mode-'))

  try {
    writeFileSync(resolve(webRoot, 'index.html.template'), indexTemplate)
    writeFileSync(resolve(webRoot, 'index.html'), 'stale generated content\n')
    writeFileSync(resolve(webRoot, 'robots-allow.txt'), 'User-agent: *\nAllow: /\n')
    writeFileSync(resolve(webRoot, 'robots-block.txt'), 'User-agent: *\nDisallow: /\n')

    execFileSync('sh', [script], {
      env: { ...process.env, PUBLIC_MODE: publicMode, WEB_ROOT: webRoot },
      stdio: 'pipe',
    })

    return {
      index: readFileSync(resolve(webRoot, 'index.html'), 'utf8'),
      robots: readFileSync(resolve(webRoot, 'robots.txt'), 'utf8'),
    }
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
}

test('PUBLIC_MODE=true enables public metadata and crawling', () => {
  const result = runEntrypoint('true')

  assert.match(result.index, /PokéCollector — Pokemon TCG Collection Manager/)
  assert.match(result.index, /<meta name="description"/)
  assert.doesNotMatch(result.index, /noindex/)
  assert.match(result.robots, /Allow: \//)
})

test('PUBLIC_MODE=false keeps the frontend private', () => {
  const result = runEntrypoint('false')

  assert.match(result.index, /noindex, nofollow/)
  assert.match(result.index, /Pokemon TCG Collection/)
  assert.match(result.robots, /Disallow: \//)
})

test('an invalid PUBLIC_MODE value defaults to private mode', () => {
  const result = runEntrypoint('unexpected')

  assert.match(result.index, /noindex, nofollow/)
  assert.match(result.robots, /Disallow: \//)
})
