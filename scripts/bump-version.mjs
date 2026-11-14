import { lstatSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bumpVersionFiles, readVersionFiles, nextPatch, compareVersions, VERSION_FILES } from './version.mjs'

try {
  const args = process.argv.slice(2)
  let root = resolve(import.meta.dirname, '..'), requested, dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i])
    else if (args[i] === '--dry-run') dryRun = true
    else if (!requested && !args[i].startsWith('-')) requested = args[i]
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
  }
  if (!requested) throw new Error('Usage: node scripts/bump-version.mjs patch|<version> [--dry-run]')
  const files = readVersionFiles(root)
  const previous = files.VERSION.trim()
  const next = requested === 'patch' ? nextPatch(previous) : requested
  if (compareVersions(next, previous) <= 0) throw new Error(`Version ${next} must be newer than ${previous}.`)
  const updated = bumpVersionFiles(files, next)
  // Preflight every path before the first write. Git retains the original revision.
  for (const file of VERSION_FILES) if (!lstatSync(resolve(root, file)).isFile()) throw new Error(`Not a regular file: ${file}`)
  if (!dryRun) for (const file of VERSION_FILES) writeFileSync(resolve(root, file), updated[file])
  console.log(`${dryRun ? 'Would update' : 'Updated'} ${previous} -> ${next}: ${VERSION_FILES.join(', ')}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
