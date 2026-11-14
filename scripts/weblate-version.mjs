import { bumpVersionFiles, checkVersionFiles, compareVersions, nextPatch, VERSION_FILES } from './version.mjs'

export function planWeblateVersion({ files, baseFiles, comparisonFiles, changes, cataloguePaths, tags }) {
  const allowedCatalogues = new Set(cataloguePaths.filter(p => /^frontend\/src\/i18n\/locales\/[a-zA-Z0-9-]+\.json$/.test(p) && !p.endsWith('/en.json')))
  if (!changes.length || changes.length > 200) throw new Error('Unexpected Weblate change count.')
  let translations = 0
  for (const change of changes) {
    if (change.status !== 'modified') throw new Error(`Only existing regular files may be modified: ${change.filename}`)
    if (allowedCatalogues.has(change.filename)) translations++
    else if (!VERSION_FILES.includes(change.filename)) throw new Error(`Not a translation/version-only PR: ${change.filename}`)
  }
  if (!translations) throw new Error('No translation changes found; refusing automatic version writes.')
  const current = checkVersionFiles(files), base = checkVersionFiles(baseFiles)
  // Allow only changes produced by the shared version updater, not arbitrary
  // dependency, Compose or README edits hidden among translation changes.
  const expected = bumpVersionFiles(comparisonFiles, current)
  for (const path of VERSION_FILES) if (expected[path] !== files[path]) throw new Error(`Non-version change in ${path}; manual review required.`)
  let version = current
  const released = v => tags.includes(`v${v}`)
  if (compareVersions(current, base) <= 0 || released(current)) {
    version = nextPatch(base)
    for (let attempts = 0; released(version); attempts++) {
      if (attempts >= 1000) throw new Error('Unable to find an unused patch version.')
      version = nextPatch(version)
    }
    // Never lower a newer unreleased/prerelease proposal when skipping old tags.
    if (compareVersions(version, current) <= 0) version = nextPatch(current)
    while (released(version)) version = nextPatch(version)
  }
  const all = bumpVersionFiles(files, version)
  return { version, updated: Object.fromEntries(VERSION_FILES.filter(p => all[p] !== files[p]).map(p => [p, all[p]])) }
}
