// Reproducibly scope the pinned, unmodified upstream styles. No runtime CDN.
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
const source = new URL('public/holo-effects/source/', root)
const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', source), 'utf8'))
const parts = ['/*! pokemon-cards-css by Simon Goellner (@simeydotme), GPL-3.0.\n * Modified: namespace .card* selectors, scope :root variables, local texture URLs.\n * Original source/license: /holo-effects/source/. See manifest.json for the pinned revision. */']
for (const item of manifest.css) {
  const bytes = await fs.readFile(new URL(item.path, source))
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw Error(`Changed upstream source: ${item.path}`)
  parts.push(bytes.toString().replaceAll(':root', '.pc-holo-card').replace(/\.card(?=[\s_\[.:,#>+~{)]|$)/g, '.pc-holo-card').replaceAll('/img/', '/holo-effects/textures/'))
}
const output = new URL('src/vendor/pokemon-cards-css/scoped.css', root)
await fs.mkdir(fileURLToPath(new URL('.', output)), { recursive: true })
await fs.writeFile(output, parts.join('\n'))
console.log(`Scoped ${manifest.css.length} hash-verified upstream stylesheets`)
