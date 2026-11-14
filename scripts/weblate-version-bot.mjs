// Run only from trusted main in the write-enabled workflow. PR trees are data,
// never checked out or executed here. Authentication stays in native gh's env.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { planWeblateVersion } from './weblate-version.mjs'
import { VERSION_FILES } from './version.mjs'

const branch = 'weblate-translations'
const main = 'main'
const shaPattern = /^[0-9a-f]{40}$/
function sha(value) {
  if (!shaPattern.test(value)) throw new Error('Invalid Git object identifier.')
  return value
}

export function ghAPI(path, method = 'GET', data, paginate = false) {
  const args = ['api', path, '--method', method]
  if (paginate) args.push('--paginate', '--slurp')
  if (data !== undefined) args.push('--input', '-')
  const r = spawnSync('gh', args, { input: data === undefined ? undefined : JSON.stringify(data), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`GitHub ${method} ${path} failed: ${r.error?.message ?? r.stderr}`)
  const result = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return paginate ? result.flat() : result
}

export function updateWeblatePullRequest(api, repo, number) {
  if (repo !== 'Git-Romer/pokecollector' || !Number.isSafeInteger(number) || number < 1) throw new Error('Unexpected repository or PR number.')
  const prefix = `repos/${repo}`
  const eligible = p => p.state === 'open' && !p.draft && p.base.ref === main && p.base.repo.full_name === repo && p.head.ref === branch && p.head.repo.full_name === repo
  const pr = api(`${prefix}/pulls/${number}`)
  if (!eligible(pr)) return { skipped: true }
  const head = sha(pr.head.sha)
  const base = sha(api(`${prefix}/git/ref/heads/${main}`).object.sha)
  const mergeBase = sha(api(`${prefix}/compare/${base}...${head}`).merge_base_commit.sha)
  const changes = api(`${prefix}/pulls/${number}/files?per_page=100`, 'GET', undefined, true)
  if (changes.length !== pr.changed_files) throw new Error('PR file inventory changed or was truncated; retry against its current head.')
  const trees = new Map(), treeIds = new Map(), blobs = new Map()
  function tree(ref) {
    if (!trees.has(ref)) {
      const data = api(`${prefix}/git/trees/${ref}?recursive=1`)
      if (data.truncated) throw new Error('Truncated Git tree; refusing incomplete validation.')
      treeIds.set(ref, sha(data.sha))
      trees.set(ref, new Map(data.tree.map(e => [e.path, e])))
    }
    return trees.get(ref)
  }
  function readFiles(ref) {
    return Object.fromEntries(VERSION_FILES.map(path => {
      const entry = tree(ref).get(path)
      if (!entry || entry.mode !== '100644' || entry.type !== 'blob' || entry.size > 2 * 1024 * 1024) throw new Error(`Unsafe metadata file: ${path}`)
      const id = sha(entry.sha)
      if (!blobs.has(id)) {
        const blob = api(`${prefix}/git/blobs/${id}`)
        if (blob.encoding !== 'base64' || blob.size > 2 * 1024 * 1024) throw new Error(`Invalid metadata blob: ${path}`)
        const bytes = Buffer.from(blob.content, 'base64')
        if (bytes.length !== blob.size) throw new Error('Invalid Git blob length.')
        blobs.set(id, bytes.toString('utf8'))
      }
      return [path, blobs.get(id)]
    }))
  }
  const cataloguePaths = [...tree(base).values()].filter(e => e.type === 'blob' && e.mode === '100644').map(e => e.path)
  // Changed translations must be ordinary files too, even though they are never executed.
  for (const change of changes) {
    const entry = tree(head).get(change.filename)
    if (!entry || entry.type !== 'blob' || entry.mode !== '100644') throw new Error(`Unsafe changed file: ${change.filename}`)
  }
  const tags = api(`${prefix}/tags?per_page=100`, 'GET', undefined, true).map(t => t.name)
  const plan = planWeblateVersion({ files: readFiles(head), baseFiles: readFiles(base), comparisonFiles: readFiles(mergeBase), changes, cataloguePaths, tags })
  if (!Object.keys(plan.updated).length) return { version: plan.version, unchanged: true }
  const stillCurrent = () => {
    const current = api(`${prefix}/pulls/${number}`)
    if (!eligible(current) || current.head.sha !== head || api(`${prefix}/git/ref/heads/${main}`).object.sha !== base) throw new Error('PR or main advanced during planning; no branch update was made. Rerun the job.')
  }
  stillCurrent()
  // A single new tree/commit atomically contains all five version files.
  const newTree = api(`${prefix}/git/trees`, 'POST', { base_tree: treeIds.get(head), tree: Object.entries(plan.updated).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) })
  const commit = api(`${prefix}/git/commits`, 'POST', { message: `chore(release): bump version to ${plan.version}`, tree: sha(newTree.sha), parents: [head], author: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' } })
  stillCurrent()
  api(`${prefix}/git/refs/heads/${branch}`, 'PATCH', { sha: sha(commit.sha), force: false })
  const updated = api(`${prefix}/pulls/${number}`)
  if (updated.head.sha !== commit.sha) throw new Error('The branch changed before readback; inspect the current PR before retrying.')
  return { version: plan.version, commit: commit.sha }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const repo = process.env.GITHUB_REPOSITORY
    if (repo !== 'Git-Romer/pokecollector') throw new Error('This job is scoped to Git-Romer/pokecollector.')
    if (!process.env.GH_TOKEN) throw new Error('Configure WEBLATE_VERSION_TOKEN with the dedicated repository Contents-write token, not GITHUB_TOKEN.')
    const requested = process.env.PR_NUMBER
    if (requested && !/^[1-9]\d*$/.test(requested)) throw new Error('Invalid PR number.')
    const numbers = requested ? [Number(requested)] : ghAPI(`repos/${repo}/pulls?state=open&base=${main}&head=Git-Romer:${branch}&per_page=100`, 'GET', undefined, true).map(p => p.number)
    if (numbers.length > 1) throw new Error('More than one open Weblate PR; refusing ambiguous writes.')
    for (const number of numbers) console.log(JSON.stringify({ pr: number, ...updateWeblatePullRequest(ghAPI, repo, number) }))
    if (!numbers.length) console.log('No open Weblate translation PR to update.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
