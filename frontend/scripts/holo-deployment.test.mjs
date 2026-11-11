import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = name => fs.readFileSync(new URL(name, root), 'utf8')
const publisher = 'https://pokecollector.romerg.de'

test('shipped frontend CSP permits the exact official publisher without widening unrelated directives', () => {
  const nginx = read('nginx.conf')
  const policy = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1]
  assert.ok(policy, 'production CSP must be explicit')
  const directives = Object.fromEntries(policy.split(';').map(part => part.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values]))
  assert.deepEqual(directives['connect-src'], [
    "'self'", publisher, 'https://api.tcgdex.net', 'https://api.frankfurter.app',
    'https://api.github.com', 'https://raw.githubusercontent.com',
    'https://generativelanguage.googleapis.com',
  ])
  assert.deepEqual(directives['script-src'], ["'self'"])
})

test('image build exposes a publisher-origin override and local Compose forwards explicit empty values', () => {
  const dockerfile = read('Dockerfile')
  assert.ok(dockerfile.includes(`ARG VITE_HOLO_EFFECTS_API_BASE_URL=${publisher}`))
  assert.ok(dockerfile.includes('ENV VITE_HOLO_EFFECTS_API_BASE_URL=$VITE_HOLO_EFFECTS_API_BASE_URL'))
  assert.ok(dockerfile.indexOf('ARG VITE_HOLO_EFFECTS_API_BASE_URL=') < dockerfile.indexOf('npm run build'))
  const compose = read('../docker-compose.build.yml')
  assert.ok(compose.includes('VITE_HOLO_EFFECTS_API_BASE_URL: ${VITE_HOLO_EFFECTS_API_BASE_URL-https://pokecollector.romerg.de}'))
})
