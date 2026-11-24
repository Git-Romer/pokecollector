import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const dockerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker-entrypoint.d')
const publicScript = resolve(dockerDir, '40-configure-public-mode.sh')
const pwaScript = resolve(dockerDir, '45-configure-pwa.sh')
const indexTemplate = '<!doctype html><html><head><title>Pokemon TCG Collection</title></head><body><div id="root"></div></body></html>\n'

function setup() {
  const webRoot = mkdtempSync(resolve(tmpdir(), 'pokecollector-pwa-'))
  writeFileSync(resolve(webRoot, 'index.html.template'), indexTemplate)
  writeFileSync(resolve(webRoot, 'robots-allow.txt'), 'User-agent: *\nAllow: /\n')
  writeFileSync(resolve(webRoot, 'robots-block.txt'), 'User-agent: *\nDisallow: /\n')
  writeFileSync(resolve(webRoot, 'sw.real.js'), '// real worker\n')
  writeFileSync(resolve(webRoot, 'sw.kill.js'), '// kill worker\n')
  return webRoot
}

function run(webRoot, env) {
  const full = { ...process.env, WEB_ROOT: webRoot, PUBLIC_MODE: '', PWA_ENABLED: '', OFFLINE_QUEUE_ENABLED: '', ...env }
  // Same order as the nginx image: 40- resets index.html from the template, 45- adds the flags.
  execFileSync('sh', [publicScript], { env: full, stdio: 'pipe' })
  execFileSync('sh', [pwaScript], { env: full, stdio: 'pipe' })
  return {
    index: readFileSync(resolve(webRoot, 'index.html'), 'utf8'),
    sw: readFileSync(resolve(webRoot, 'sw.js'), 'utf8'),
  }
}

const metaCount = index => (index.match(/name="pokecollector-pwa"/g) || []).length

const matrix = [
  ['true', 'sw=1', '// real worker\n'],
  ['TRUE', 'sw=1', '// real worker\n'],
  ['1', 'sw=1', '// real worker\n'],
  ['false', 'sw=0', '// kill worker\n'],
  ['off', 'sw=0', '// kill worker\n'],
  ['', 'sw=0', '// kill worker\n'],
  ['maybe', 'sw=0', '// kill worker\n'],
]

for (const [value, flag, worker] of matrix) {
  test(`PWA_ENABLED=${JSON.stringify(value)} gives ${flag}`, () => {
    const webRoot = setup()
    try {
      const result = run(webRoot, { PWA_ENABLED: value })
      assert.equal(metaCount(result.index), 1)
      assert.ok(result.index.includes(`content="${flag};queue=0" /></head>`), result.index)
      assert.equal(result.sw, worker)
    } finally {
      rmSync(webRoot, { recursive: true, force: true })
    }
  })
}

test('OFFLINE_QUEUE_ENABLED is reflected independently', () => {
  const webRoot = setup()
  try {
    const result = run(webRoot, { PWA_ENABLED: 'true', OFFLINE_QUEUE_ENABLED: 'yes' })
    assert.ok(result.index.includes('content="sw=1;queue=1"'))
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})

test('an invalid value warns and uses the default', () => {
  const webRoot = setup()
  try {
    execFileSync('sh', [publicScript], { env: { ...process.env, WEB_ROOT: webRoot, PUBLIC_MODE: '' }, stdio: 'pipe' })
    // The script exits 0 (a non-zero exit would throw here) and falls back to the default.
    execFileSync('sh', [pwaScript], { env: { ...process.env, WEB_ROOT: webRoot, PWA_ENABLED: 'bogus' }, stdio: 'pipe' })
    assert.ok(readFileSync(resolve(webRoot, 'index.html'), 'utf8').includes('sw=0;queue=0'))
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})

test('PUBLIC_MODE=true keeps the SEO tags and adds the flags exactly once', () => {
  const webRoot = setup()
  try {
    const result = run(webRoot, { PUBLIC_MODE: 'true', PWA_ENABLED: 'true' })
    assert.equal(metaCount(result.index), 1)
    assert.equal((result.index.match(/<meta name="description"/g) || []).length, 1)
    assert.match(result.index, /<title>PokéCollector/)
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})

test('re-running after the template reset does not accumulate flags', () => {
  const webRoot = setup()
  try {
    run(webRoot, { PWA_ENABLED: 'true' })
    copyFileSync(resolve(webRoot, 'index.html.template'), resolve(webRoot, 'index.html'))
    const second = run(webRoot, { PWA_ENABLED: 'true' })
    assert.equal(metaCount(second.index), 1)
    // Running 45- alone twice would accumulate; the entrypoint order (40- first) prevents it.
    const third = run(webRoot, { PWA_ENABLED: 'false' })
    assert.equal(metaCount(third.index), 1)
    assert.ok(third.index.includes('sw=0;queue=0'))
    assert.equal(third.sw, '// kill worker\n')
  } finally {
    rmSync(webRoot, { recursive: true, force: true })
  }
})
