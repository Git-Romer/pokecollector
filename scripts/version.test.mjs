import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { bumpVersionFiles, compareVersions, nextPatch, parseVersion, readVersionFiles } from './version.mjs'

const root = resolve(import.meta.dirname, '..')
const files = ['VERSION', 'frontend/package.json', 'frontend/package-lock.json', 'docker-compose.yml', 'README.md']
function fixture(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'version-policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true })
    writeFileSync(resolve(dir, file), readFileSync(resolve(root, file)))
  }
  function git(...args) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q'); git('config', 'user.name', 'Version test'); git('config', 'user.email', 'version@example.invalid')
  git('add', '.'); git('commit', '-qm', 'Initial version')
  return { dir, git, run: (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/check-version.mjs'), '--root', dir, ...args], { encoding: 'utf8' }) }
}

test('the shared bump command updates every reference and makes the gate pass', t => {
  const f = fixture(t)
  const before = readFileSync(resolve(f.dir, 'VERSION'), 'utf8').trim()
  const next = before.replace(/(\d+)$/, n => String(BigInt(n) + 1n))
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/bump-version.mjs'), '--root', f.dir, 'patch'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(resolve(f.dir, 'VERSION'), 'utf8').trim(), next)
  const check = f.run('--base', 'HEAD')
  assert.equal(check.status, 0, check.stderr)
  assert.equal(f.git('diff', '--name-only').split('\n').length, 5)
})

test('the version gate rejects an unchanged version relative to the target', t => {
  const f = fixture(t)
  const r = f.run('--base', 'HEAD')
  assert.notEqual(r.status, 0, 'An unchanged version must not pass the PR gate')
  assert.match(r.stderr, /newer|increase/i)
})

for (const [left, right, expected] of [['1.10.0', '1.9.9', 1], ['2.0.0', '1.99.99', 1], ['1.2.3-rc.10', '1.2.3-rc.2', 1], ['1.2.3', '1.2.3-rc.9', 1], ['1.2.3-alpha', '1.2.3-beta', -1], ['1.2.3+one', '1.2.3+two', 0]]) {
  test(`SemVer ordering: ${left} versus ${right}`, () => assert.equal(compareVersions(left, right), expected))
}

test('invalid SemVer identifiers are rejected and prereleases promote to stable', () => {
  for (const v of ['01.2.3', '1.2', '1.2.3-01', '1.2.3-rc..1', 'v1.2.3', '1.2.3\nextra']) assert.throws(() => parseVersion(v))
  assert.equal(nextPatch('1.2.3-rc.2'), '1.2.3')
  assert.equal(nextPatch('1.2.9'), '1.2.10')
})

test('explicit minor/major versions and dry runs use the same updater', t => {
  const f = fixture(t), original = readVersionFiles(f.dir)
  const next = `${BigInt(original.VERSION.trim().split('.')[0]) + 1n}.0.0`
  const command = (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/bump-version.mjs'), '--root', f.dir, ...args], { encoding: 'utf8' })
  assert.equal(command(next, '--dry-run').status, 0)
  assert.deepEqual(readVersionFiles(f.dir), original)
  assert.equal(command(next).status, 0)
  assert.equal(f.run('--base', 'HEAD').status, 0)
  assert.equal(command('0.0.1').status, 1)
  assert.equal(readVersionFiles(f.dir).VERSION.trim(), next)
})

test('inconsistent input fails before the bump writes any files', t => {
  const f = fixture(t)
  writeFileSync(resolve(f.dir, 'VERSION'), '9.8.7\n')
  const before = readVersionFiles(f.dir)
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/bump-version.mjs'), '--root', f.dir, 'patch'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.deepEqual(readVersionFiles(f.dir), before)
})

test('release tag reuse fails, except a main push tagged at that exact commit', t => {
  const f = fixture(t), version = readVersionFiles(f.dir).VERSION.trim()
  f.git('tag', `v${version}`)
  assert.equal(f.run('--check-tags').status, 1)
  assert.equal(f.run('--check-tags', '--allow-tag-at-head').status, 0)
  f.git('commit', '--allow-empty', '-qm', 'Another commit')
  assert.equal(f.run('--check-tags', '--allow-tag-at-head').status, 1)
})

test('immutable candidate inspection ignores dirty working-tree contents', t => {
  const f = fixture(t)
  writeFileSync(resolve(f.dir, 'VERSION'), 'broken\n')
  assert.equal(f.run('--candidate', 'HEAD').status, 0)
  assert.equal(f.run().status, 1)
})

test('the legacy skip-readme flag permits a checkout without README', t => {
  const f = fixture(t)
  rmSync(resolve(f.dir, 'README.md'))
  assert.equal(f.run('--skip-readme').status, 0)
})

test('an unrelated README change survives a manual version bump byte-for-byte', () => {
  const files = readVersionFiles(root)
  files['README.md'] += '\nA contributor note.\n'
  const updated = bumpVersionFiles(files, nextPatch(files.VERSION.trim()))
  assert.ok(updated['README.md'].endsWith('\nA contributor note.\n'))
  const originalLock = JSON.parse(files['frontend/package-lock.json'])
  const updatedLock = JSON.parse(updated['frontend/package-lock.json'])
  updatedLock.version = originalLock.version
  updatedLock.packages[''].version = originalLock.packages[''].version
  assert.deepEqual(updatedLock, originalLock)
})
