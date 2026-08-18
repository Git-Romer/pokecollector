import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { checkComposePorts } from './check-compose-ports.mjs'

const composeUrl = new URL('../docker-compose.yml', import.meta.url)
const compose = await readFile(composeUrl, 'utf8')

function replaceOnce(source, search, replacement) {
  assert.ok(source.includes(search), `Expected compose fixture to include ${search}`)
  return source.replace(search, replacement)
}

test('the current compose host-port mappings are correct', () => {
  assert.deepEqual(checkComposePorts(compose), [])
})

test('backend requires the colon default form so an empty variable keeps the stable host port', () => {
  const mutated = replaceOnce(compose, '${BACKEND_PORT:-8000}', '${BACKEND_PORT-8000}')

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('frontend requires the colon default form so an empty variable keeps the stable host port', () => {
  const mutated = replaceOnce(compose, '${FRONTEND_PORT:-3000}', '${FRONTEND_PORT-3000}')

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('backend requires the expected published-port default', () => {
  const mutated = replaceOnce(compose, '${BACKEND_PORT:-8000}', '${BACKEND_PORT:-9000}')

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('backend rejects a fully hardcoded port mapping', () => {
  const mutated = replaceOnce(compose, '"${BACKEND_PORT:-8000}:8000"', '"8000:8000"')

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('frontend requires the expected container port', () => {
  const mutated = replaceOnce(compose, '"${FRONTEND_PORT:-3000}:80"', '"${FRONTEND_PORT:-3000}:8080"')

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('another published port alongside the parameterised one is accepted', () => {
  const mutated = replaceOnce(
    compose,
    '      - "${BACKEND_PORT:-8000}:8000"',
    '      - "9000:9000"\n      - "${BACKEND_PORT:-8000}:8000"',
  )

  assert.deepEqual(checkComposePorts(mutated), [])
})

test('the mapping only counts inside the service ports list', () => {
  const mutated = replaceOnce(
    compose,
    '      - "${BACKEND_PORT:-8000}:8000"',
    '      - "${BACKEND_PORT-8000}:8000"\n    x-port-check:\n      - "${BACKEND_PORT:-8000}:8000"',
  )

  assert.ok(checkComposePorts(mutated).length > 0)
})

test('a service-shaped block outside the services section cannot stand in for a service', () => {
  const decoy = 'x-templates:\n  backend:\n    ports:\n      - "${BACKEND_PORT:-8000}:8000"\n\n'

  // The decoy is ignored and the real services still satisfy the check.
  assert.deepEqual(checkComposePorts(decoy + compose), [])

  // The decoy cannot mask a real service that is broken.
  const broken = replaceOnce(compose, '${BACKEND_PORT:-8000}', '${BACKEND_PORT-8000}')
  assert.ok(checkComposePorts(decoy + broken).length > 0)
})

test('an unrelated compose setting is not reported', () => {
  const mutated = replaceOnce(compose, '${POSTGRES_PASSWORD:-changeme}', '${POSTGRES_PASSWORD:-different}')

  assert.deepEqual(checkComposePorts(mutated), [])
})
