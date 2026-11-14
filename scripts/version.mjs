import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export const VERSION_FILES = ['VERSION', 'frontend/package.json', 'frontend/package-lock.json', 'docker-compose.yml', 'README.md']

export function parseVersion(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!m || m[4]?.split('.').some(s => /^\d+$/.test(s) && s.length > 1 && s.startsWith('0'))) throw new Error(`Invalid SemVer: ${value}`)
  return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') ?? [] }
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i]
    if (l === r) continue
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r)
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1
    if (ln !== rn) return ln ? -1 : 1
    return l > r ? 1 : -1
  }
  return 0
}

export function validateReleaseVersion(value) {
  parseVersion(value)
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('The version must also be a valid Docker image tag (no +build suffix).')
  return value
}

export function nextPatch(value) {
  const { core, pre } = parseVersion(value)
  if (!pre.length) core[2] += 1n
  return core.join('.')
}

export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
}

export function resolveCommit(root, ref) {
  return git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
}

export function readVersionFiles(root, ref, { skipReadme = false } = {}) {
  const sha = ref ? resolveCommit(root, ref) : null
  return Object.fromEntries(VERSION_FILES.map(path => [path, skipReadme && path === 'README.md' ? '' : sha ? execFileSync('git', ['-C', root, 'show', `${sha}:${path}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) : readFileSync(resolve(root, path), 'utf8')]))
}

export function bumpVersionFiles(files, next) {
  const previous = checkVersionFiles(files)
  validateReleaseVersion(next)
  if (compareVersions(next, previous) < 0) throw new Error('Refusing to lower the version.')
  const result = { ...files, VERSION: `${next}\n` }
  for (const file of ['frontend/package.json', 'frontend/package-lock.json']) {
    const data = JSON.parse(files[file])
    if (JSON.stringify(data, null, 2) + '\n' !== files[file]) throw new Error(`Nonstandard JSON formatting in ${file}; refusing unrelated formatting changes.`)
    data.version = next
    if (file.endsWith('package-lock.json')) data.packages[''].version = next
    result[file] = JSON.stringify(data, null, 2) + '\n'
  }
  for (const image of ['backend', 'frontend']) {
    const old = 'image: ghcr.io/git-romer/pokecollector-' + image + ':${POKECOLLECTOR_VERSION:-' + previous + '}'
    const updated = 'image: ghcr.io/git-romer/pokecollector-' + image + ':${POKECOLLECTOR_VERSION:-' + next + '}'
    result['docker-compose.yml'] = result['docker-compose.yml'].replaceAll(old, updated)
  }
  result['README.md'] = result['README.md'].replaceAll(`version-v${previous}-`, `version-v${next}-`).replaceAll(`Current version:** \`v${previous}\``, `Current version:** \`v${next}\``)
  checkVersionFiles(result)
  return result
}

export function checkVersionFiles(files, { skipReadme = false } = {}) {
  const version = files.VERSION.trim()
  validateReleaseVersion(version)
  const errors = []
  const pkg = JSON.parse(files['frontend/package.json'])
  const lock = JSON.parse(files['frontend/package-lock.json'])
  for (const [name, actual] of [['frontend/package.json', pkg.version], ['frontend/package-lock.json', lock.version], ['frontend/package-lock.json root package', lock.packages?.['']?.version]]) {
    if (actual !== version) errors.push(`${name} version ${actual} does not match VERSION ${version}`)
  }
  for (const image of ['backend', 'frontend']) {
    const expected = 'image: ghcr.io/git-romer/pokecollector-' + image + ':${POKECOLLECTOR_VERSION:-' + version + '}'
    if (!files['docker-compose.yml'].includes(expected)) errors.push(`docker-compose.yml must use ${expected}`)
  }
  if (!skipReadme) {
    if (!files['README.md'].includes(`version-v${version}-`)) errors.push(`README version badge does not reference v${version}`)
    if (!files['README.md'].includes(`Current version:** \`v${version}\``)) errors.push(`README current version text does not reference v${version}`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return version
}
