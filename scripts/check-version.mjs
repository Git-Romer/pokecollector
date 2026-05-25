import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim()
const packageJson = JSON.parse(readFileSync(resolve(root, 'frontend/package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(resolve(root, 'frontend/package-lock.json'), 'utf8'))
const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const errors = []
if (!semverPattern.test(version)) {
  errors.push(`VERSION must be SemVer, got ${version}`)
}
if (packageJson.version !== version) {
  errors.push(`frontend/package.json version ${packageJson.version} does not match VERSION ${version}`)
}
if (packageLock.version !== version) {
  errors.push(`frontend/package-lock.json version ${packageLock.version} does not match VERSION ${version}`)
}
if (packageLock.packages?.['']?.version !== version) {
  errors.push(`frontend/package-lock.json root package version ${packageLock.packages?.['']?.version} does not match VERSION ${version}`)
}
if (!readme.includes(`version-v${version}-`)) {
  errors.push(`README version badge does not reference v${version}`)
}
if (!readme.includes(`Current version:** \`v${version}\``)) {
  errors.push(`README current version text does not reference v${version}`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`Version ${version} is consistent.`)
