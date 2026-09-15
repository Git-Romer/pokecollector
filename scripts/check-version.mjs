import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim()
const packageJson = JSON.parse(readFileSync(resolve(root, 'frontend/package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(resolve(root, 'frontend/package-lock.json'), 'utf8'))
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const dockerTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const skipReadme = process.argv.includes('--skip-readme') || process.env.SKIP_README_VERSION_CHECK === 'true'
const readme = skipReadme ? '' : readFileSync(resolve(root, 'README.md'), 'utf8')
const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8')

const errors = []
if (!semverPattern.test(version)) {
  errors.push(`VERSION must be SemVer, got ${version}`)
}
if (!dockerTagPattern.test(version)) {
  errors.push(`VERSION must also be a valid Docker tag, got ${version}`)
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
const expectedImageTag = `\${POKECOLLECTOR_VERSION:-${version}}`
for (const image of ['backend', 'frontend']) {
  const expectedImage = `image: ghcr.io/git-romer/pokecollector-${image}:${expectedImageTag}`
  if (!compose.includes(expectedImage)) {
    errors.push(`docker-compose.yml must use ${expectedImage} for the ${image} release image`)
  }
}
if (!skipReadme && !readme.includes(`version-v${version}-`)) {
  errors.push(`README version badge does not reference v${version}`)
}
if (!skipReadme && !readme.includes(`Current version:** \`v${version}\``)) {
  errors.push(`README current version text does not reference v${version}`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`Version ${version} is consistent.`)
