import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readVersionFiles, VERSION_FILES } from './version.mjs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

test('the API writer refuses a PR outside the exact Weblate branch before any write', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const calls = []
  const api = (path, method = 'GET') => {
    calls.push([path, method])
    return { state: 'open', base: { ref: 'main', repo: { full_name: 'Git-Romer/pokecollector' } }, head: { ref: 'someone-elses-branch', repo: { full_name: 'Git-Romer/pokecollector' } } }
  }
  assert.equal(updateWeblatePullRequest(api, 'Git-Romer/pokecollector', 12).skipped, true)
  assert.deepEqual(calls.map(c => c[1]), ['GET'])
})

test('a translation-only Weblate change gets one synchronized patch bump', async () => {
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const files = readVersionFiles(root)
  const plan = planWeblateVersion({ files, baseFiles: files, comparisonFiles: files, changes: [{ filename: 'frontend/src/i18n/locales/de.json', status: 'modified' }], cataloguePaths: ['frontend/src/i18n/locales/de.json'], tags: [] })
  assert.equal(plan.version, files.VERSION.trim().replace(/(\d+)$/, n => String(BigInt(n) + 1n)))
  assert.deepEqual(Object.keys(plan.updated).sort(), [...VERSION_FILES].sort())
})

function apiFixture(files) {
  const base = '1'.repeat(40), head = '2'.repeat(40), treeId = '3'.repeat(40), newTree = '4'.repeat(40), newCommit = '5'.repeat(40)
  let currentHead = head
  const writes = [], blobs = new Map()
  const entries = VERSION_FILES.map((path, i) => {
    const id = (i + 6).toString(16).repeat(40)
    blobs.set(id, { content: Buffer.from(files[path]).toString('base64'), encoding: 'base64', size: Buffer.byteLength(files[path]) })
    return { path, sha: id, mode: '100644', type: 'blob', size: Buffer.byteLength(files[path]) }
  })
  const locale = 'frontend/src/i18n/locales/de.json'
  entries.push({ path: locale, sha: 'a'.repeat(40), mode: '100644', type: 'blob', size: 10 })
  const pr = () => ({ state: 'open', draft: false, changed_files: 1, base: { ref: 'main', repo: { full_name: 'Git-Romer/pokecollector' } }, head: { ref: 'weblate-translations', sha: currentHead, repo: { full_name: 'Git-Romer/pokecollector' } } })
  const prefix = 'repos/Git-Romer/pokecollector'
  function api(path, method = 'GET', data) {
    if (method !== 'GET') {
      writes.push({ path, method, data })
      if (path.endsWith('/git/trees')) {
        assert.equal(data.base_tree, treeId, 'Create-tree must use a tree SHA, not a commit SHA')
        assert.deepEqual(data.tree.map(e => e.path).sort(), [...VERSION_FILES].sort())
        return { sha: newTree }
      }
      if (path.endsWith('/git/commits')) { assert.deepEqual(data.parents, [head]); return { sha: newCommit } }
      if (path.endsWith('/git/refs/heads/weblate-translations')) { assert.equal(data.force, false); currentHead = data.sha; return {} }
      throw new Error(`Unexpected write: ${path}`)
    }
    if (path === `${prefix}/pulls/12`) return pr()
    if (path === `${prefix}/git/ref/heads/main`) return { object: { sha: base } }
    if (path.includes('/compare/')) return { merge_base_commit: { sha: base } }
    if (path.includes('/pulls/12/files')) return [{ filename: locale, status: 'modified' }]
    if (path.includes('/git/trees/')) return { sha: treeId, truncated: false, tree: entries }
    if (path.includes('/git/blobs/')) return blobs.get(path.split('/').at(-1))
    if (path.includes('/tags?')) return []
    throw new Error(`Unexpected read: ${path}`)
  }
  return { api, writes, entries, head, newCommit, advance: () => { currentHead = 'b'.repeat(40) } }
}

test('the API writer atomically commits only metadata and never force-pushes', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  const r = updateWeblatePullRequest(f.api, 'Git-Romer/pokecollector', 12)
  assert.equal(r.commit, f.newCommit)
  assert.deepEqual(f.writes.map(w => w.method), ['POST', 'POST', 'PATCH'])
})

function planFixture() {
  const files = readVersionFiles(root)
  return { files, baseFiles: files, comparisonFiles: files, changes: [{ filename: 'frontend/src/i18n/locales/de.json', status: 'modified' }], cataloguePaths: ['frontend/src/i18n/locales/de.json'], tags: [] }
}

test('repeated automation keeps an existing bump and makes no further changes', async () => {
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const f = planFixture(), first = planWeblateVersion(f)
  const repeated = planWeblateVersion({ ...f, files: { ...f.files, ...first.updated } })
  assert.equal(repeated.version, first.version)
  assert.deepEqual(repeated.updated, {})
})

test('an advancing main refreshes the patch and skips already released versions', async () => {
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const { bumpVersionFiles, nextPatch } = await import('./version.mjs')
  const f = planFixture(), first = planWeblateVersion(f)
  const newMain = bumpVersionFiles(f.files, first.version)
  const blocked = nextPatch(first.version)
  const refreshed = planWeblateVersion({ ...f, files: { ...f.files, ...first.updated }, baseFiles: newMain, tags: [`v${blocked}`] })
  assert.equal(refreshed.version, nextPatch(blocked))
})

test('Weblate replacing its push branch regenerates the same version, not another release', async () => {
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const f = planFixture(), first = planWeblateVersion(f)
  const afterWeblateRebase = planWeblateVersion(f)
  assert.equal(afterWeblateRebase.version, first.version)
  assert.deepEqual(afterWeblateRebase.updated, first.updated)
})

for (const filename of ['frontend/src/i18n/locales/en.json', 'frontend/src/i18n/locales/new-language.json', 'frontend/src/App.jsx', '.github/workflows/release.yml', '../VERSION']) {
  test(`automatic writes reject an unexpected path: ${filename}`, async () => {
    const { planWeblateVersion } = await import('./weblate-version.mjs')
    const f = planFixture()
    assert.throws(() => planWeblateVersion({ ...f, changes: [{ filename, status: 'modified' }] }), /Not a translation/)
  })
}

test('hidden dependency or README edits and translation deletion require manual review', async () => {
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const f = planFixture()
  assert.throws(() => planWeblateVersion({ ...f, files: { ...f.files, 'README.md': f.files['README.md'] + '\nUnrelated change\n' } }), /Non-version change/)
  assert.throws(() => planWeblateVersion({ ...f, changes: [{ ...f.changes[0], status: 'removed' }] }), /Only existing/)
})

test('the writer rejects a fork with the same branch name without writing', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  const api = (...args) => {
    const value = f.api(...args)
    if (args[0].endsWith('/pulls/12')) value.head.repo.full_name = 'someone/pokecollector'
    return value
  }
  assert.equal(updateWeblatePullRequest(api, 'Git-Romer/pokecollector', 12).skipped, true)
  assert.deepEqual(f.writes, [])
})

test('unsafe metadata modes fail closed before writing', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  f.entries.find(e => e.path === 'VERSION').mode = '120000'
  assert.throws(() => updateWeblatePullRequest(f.api, 'Git-Romer/pokecollector', 12), /Unsafe/)
  assert.deepEqual(f.writes, [])
})

test('a concurrent Weblate update prevents a stale bot branch write', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  let reads = 0
  const api = (...args) => {
    if (args[0].endsWith('/pulls/12') && ++reads === 2) f.advance()
    return f.api(...args)
  }
  assert.throws(() => updateWeblatePullRequest(api, 'Git-Romer/pokecollector', 12), /advanced/)
  assert.deepEqual(f.writes, [])
})

test('truncated repository trees fail closed before writing', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  const api = (...args) => {
    const result = f.api(...args)
    return args[0].includes('/git/trees/') ? { ...result, truncated: true } : result
  }
  assert.throws(() => updateWeblatePullRequest(api, 'Git-Romer/pokecollector', 12), /Truncated/)
  assert.deepEqual(f.writes, [])
})

test('a head change after creating the commit still prevents a stale ref update', async () => {
  const { updateWeblatePullRequest } = await import('./weblate-version-bot.mjs')
  const f = apiFixture(readVersionFiles(root))
  const api = (...args) => {
    const value = f.api(...args)
    if (args[0].endsWith('/git/commits') && args[1] === 'POST') f.advance()
    return value
  }
  assert.throws(() => updateWeblatePullRequest(api, 'Git-Romer/pokecollector', 12), /advanced/)
  assert.deepEqual(f.writes.map(w => w.method), ['POST', 'POST'])
})

test('a real Git round trip restores the same bump after Weblate replaces its branch', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { execFileSync, spawnSync } = await import('node:child_process')
  const { planWeblateVersion } = await import('./weblate-version.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'weblate-roundtrip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = join(dir, 'remote.git'), local = join(dir, 'translator')
  const git = (...args) => execFileSync('git', ['-C', local, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  execFileSync('git', ['init', '--bare', '-q', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', local])
  git('config', 'user.name', 'Translation fixture')
  git('config', 'user.email', 'translation@example.invalid')
  const original = readVersionFiles(root), locale = 'frontend/src/i18n/locales/de.json'
  const write = (path, text) => { mkdirSync(dirname(join(local, path)), { recursive: true }); writeFileSync(join(local, path), text) }
  for (const [path, text] of Object.entries(original)) write(path, text)
  write(locale, '{"one":"initial"}\n')
  git('add', '.'); git('commit', '-qm', 'Fixture baseline')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'main')
  write(locale, '{"one":"first translation"}\n')
  git('commit', '-qam', 'First translation')
  const firstTranslator = git('rev-parse', 'HEAD')
  git('push', '-q', 'origin', 'HEAD:weblate-translations')
  const input = () => ({ files: readVersionFiles(local), baseFiles: original, comparisonFiles: original, changes: [{ filename: locale, status: 'modified' }], cataloguePaths: [locale], tags: [] })
  const first = planWeblateVersion(input())
  for (const [path, text] of Object.entries(first.updated)) write(path, text)
  git('commit', '-qam', 'First automated version')
  const firstBot = git('rev-parse', 'HEAD')
  git('push', '-q', 'origin', 'HEAD:weblate-translations')
  git('reset', '--hard', firstTranslator)
  const translated = '{"one":"first translation","two":"second translation"}\n'
  write(locale, translated)
  git('commit', '-qam', 'Second translation')
  const secondTranslator = git('rev-parse', 'HEAD')
  git('push', '-q', '--force', 'origin', 'HEAD:weblate-translations')
  assert.equal(spawnSync('git', ['-C', local, 'merge-base', '--is-ancestor', firstBot, 'HEAD']).status, 1)
  const restored = planWeblateVersion(input())
  assert.equal(restored.version, first.version)
  for (const [path, text] of Object.entries(restored.updated)) write(path, text)
  git('commit', '-qam', 'Restore the same automated version')
  git('push', '-q', 'origin', 'HEAD:weblate-translations')
  for (const translator of [firstTranslator, secondTranslator]) git('merge-base', '--is-ancestor', translator, 'HEAD')
  assert.equal(execFileSync('git', ['--git-dir', remote, 'show', 'refs/heads/weblate-translations:VERSION'], { encoding: 'utf8' }).trim(), first.version)
  assert.equal(execFileSync('git', ['--git-dir', remote, 'show', `refs/heads/weblate-translations:${locale}`], { encoding: 'utf8' }), translated)
  assert.equal(git('status', '--porcelain'), '')
})
