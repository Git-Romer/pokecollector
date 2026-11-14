import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const locales = new URL('../src/i18n/locales/', import.meta.url)

test('translation data is available as nested JSON without changing English text', () => {
  const en = JSON.parse(readFileSync(new URL('en.json', locales), 'utf8'))
  assert.equal(en.nav.dashboard, 'Dashboard')
  assert.equal(en.bulkRemoval.copies, '{count} copies')
  assert.equal(en.binders.deleteConfirm.includes('{name}'), true)
})

test('translations preserve placeholders and reject blank or non-text values', async () => {
  const { validateCatalog } = await import('./translation-validation.mjs')
  const source = { greeting: 'Hello {name}', group: { count: '{count} cards' } }
  assert.deepEqual(validateCatalog({ greeting: 'Hallo {name}' }, source), [])
  assert.deepEqual(validateCatalog({}, source), []) // missing text uses English
  assert.match(validateCatalog({ greeting: 'Hallo' }, source).join('\n'), /greeting.*placeholder.*name/i)
  assert.match(validateCatalog({ greeting: 'Hallo {other}' }, source).join('\n'), /greeting.*placeholder/i)
  assert.match(validateCatalog({ greeting: '  ' }, source).join('\n'), /greeting.*empty/i)
  for (const value of [null, 1, false, [], {}]) {
    assert.notDeepEqual(validateCatalog({ greeting: value }, source), [])
  }
})

test('every shipped catalogue passes validation against English', async () => {
  const { parseCatalog, validateCatalog } = await import('./translation-validation.mjs')
  const en = parseCatalog(readFileSync(new URL('en.json', locales), 'utf8'))
  const names = readdirSync(locales).filter(name => name.endsWith('.json'))
  assert.equal(names.length, 18)
  for (const name of names) {
    const catalog = parseCatalog(readFileSync(new URL(name, locales), 'utf8'))
    assert.deepEqual(validateCatalog(catalog, en), [], name)
  }
})

test('the normal translation check rejects invalid translated files and missing UI keys', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'translation-check-'))
  try {
    mkdirSync(join(fixture, 'scripts'))
    mkdirSync(join(fixture, 'src/i18n/locales'), { recursive: true })
    for (const name of ['check-translations.mjs', 'translation-validation.mjs']) {
      cpSync(new URL(name, import.meta.url), join(fixture, 'scripts', name))
    }
    const catalogs = join(fixture, 'src/i18n/locales')
    writeFileSync(join(catalogs, 'en.json'), '{"common":{"hello":"Hello {name}"}}')
    writeFileSync(join(fixture, 'src/page.jsx'), "t('common.hello')")
    const run = () => spawnSync(process.execPath, [join(fixture, 'scripts/check-translations.mjs')], { encoding: 'utf8', timeout: 10000 })
    writeFileSync(join(catalogs, 'de.json'), '{"common":{"hello":"Hallo"}}')
    const invalid = run()
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /de.json.*common.hello.*placeholder/i)
    writeFileSync(join(catalogs, 'de.json'), '{}')
    assert.equal(run().status, 0) // incomplete languages are accepted
    writeFileSync(join(fixture, 'src/page.jsx'), "t('common.missing')")
    const missing = run()
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /page.jsx:1.*common.missing/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('JSON parsing preserves escapes and nested values and rejects malformed input', async () => {
  const { parseCatalog, validateCatalog } = await import('./translation-validation.mjs')
  const input = String.raw`{"message":"Quotes: \"x\", braces: {}, newline: \n", "a":{"same":"one"}, "b":{"same":"two"}}`
  assert.deepEqual(parseCatalog(input), JSON.parse(input))
  assert.deepEqual(parseCatalog('[true, false, null, -1.25e+2, {"x":"ok"}]'), [true, false, null, -125, { x: 'ok' }])
  assert.throws(() => parseCatalog('{"x":"a",}'), SyntaxError)
  assert.throws(() => parseCatalog('[{"x":"a","x":"b"}]'), /Duplicate key.*0.x/)
  assert.notDeepEqual(validateCatalog([], {}), [])
  assert.notDeepEqual(validateCatalog({ group: 'Text' }, { group: { title: 'Title' } }), [])
  assert.notDeepEqual(validateCatalog({ 'group.title': 'Text' }, {}), [])
  assert.deepEqual(validateCatalog({ message: '{b} / {a}' }, { message: '{a} / {b}' }), [])
})

test('duplicate keys cannot silently overwrite translated text', async () => {
  const { parseCatalog } = await import('./translation-validation.mjs')
  assert.throws(() => parseCatalog('{"nav":{"save":"First","save":"Second"}}'), /Duplicate key.*nav.save/)
  assert.throws(() => parseCatalog('{"save":"First","\\u0073ave":"Second"}'), /Duplicate key.*save/)
})
