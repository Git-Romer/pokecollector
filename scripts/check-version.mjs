import { resolve } from 'node:path'
import { checkVersionFiles, compareVersions, readVersionFiles, git, resolveCommit } from './version.mjs'

try {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--root', '--base', '--candidate'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg] = args[++i]
    } else if (['--skip-readme', '--check-tags', '--allow-tag-at-head'].includes(arg)) options[arg] = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  const root = resolve(options['--root'] ?? resolve(import.meta.dirname, '..'))
  const skipReadme = options['--skip-readme'] || process.env.SKIP_README_VERSION_CHECK === 'true'
  const files = readVersionFiles(root, options['--candidate'], { skipReadme })
  const version = checkVersionFiles(files, { skipReadme })
  if (options['--base']) {
    const base = readVersionFiles(root, options['--base']).VERSION.trim()
    if (compareVersions(version, base) <= 0) throw new Error(`Version ${version} must be newer than target version ${base}. Run node scripts/bump-version.mjs patch, or select a newer minor/major version.`)
  }
  if (options['--check-tags']) {
    const head = resolveCommit(root, options['--candidate'] ?? 'HEAD')
    for (const tag of git(root, 'tag', '--list', `v${version}`).split('\n').filter(Boolean)) {
      if (options['--allow-tag-at-head'] && resolveCommit(root, `refs/tags/${tag}`) === head) continue
      throw new Error(`Version ${version} already has release tag ${tag}; choose a new version.`)
    }
  }
  console.log(`Version ${version} is consistent${options['--base'] ? ' and newer than the target' : ''}.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
