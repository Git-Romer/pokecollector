import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')

test('the version workflow checks all pushes and PR updates without path filters', () => {
  const source = readFileSync(resolve(root, '.github/workflows/version-check.yml'), 'utf8')
  assert.doesNotMatch(source, /^\s+paths(?:-ignore)?:/m)
  assert.match(source, /^  push:/m)
  assert.match(source, /^  pull_request:/m)
  assert.match(source, /--base/)
  assert.match(source, /--check-tags/)
})

test('the write workflow runs trusted main and uses a dedicated token for fresh CI', () => {
  const source = readFileSync(resolve(root, '.github/workflows/weblate-version.yml'), 'utf8')
  assert.match(source, /pull_request_target:/)
  assert.match(source, /refs\/heads\/main/)
  assert.match(source, /secrets\.WEBLATE_VERSION_TOKEN/)
  assert.match(source, /cancel-in-progress: false/)
  assert.doesNotMatch(source, /pull_request\.head\.sha|persist-credentials: true|contents: write/)
})
