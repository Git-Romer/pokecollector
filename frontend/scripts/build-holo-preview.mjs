// Build the collection's canonical motion/profile renderer for another first-party surface.
// Generated files are not a second hand-maintained renderer.
import { build } from 'vite'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2], assetBase = process.argv[3]
if (!output || !assetBase?.startsWith('/') || !assetBase.endsWith('/')) throw Error('Usage: node scripts/build-holo-preview.mjs <output-directory> <public-asset-base/>')
const outDir = path.resolve(output)
if (outDir === root || root.startsWith(outDir + path.sep)) throw Error('Refusing unsafe output directory')
await build({ configFile:false, root, publicDir:false, plugins:[{
  name:'first-party-holo-asset-path',
  transform(source,id) { if (id.endsWith('/vendor/pokemon-cards-css/scoped.css')) return source.replaceAll('/holo-effects/', assetBase+'holo-effects/') },
}], build:{ outDir, emptyOutDir:true, lib:{entry:path.join(root,'src/holo-preview.js'),name:'HoloCollectionPreview',formats:['iife'],fileName:()=> 'collection-preview.js',cssFileName:'collection-preview'}, sourcemap:false } })
await fs.cp(path.join(root,'public/holo-effects'),path.join(outDir,'holo-effects'),{recursive:true})
const sources=['src/holo-preview.js','src/utils/holoMotion.js','src/utils/holoDeviceMotion.js','src/utils/publicCardSearch.js','src/utils/textSearch.js','src/utils/cardNumbers.js','src/components/HoloEffectOverlay.css','src/vendor/pokemon-cards-css/scoped.css']
const provenance={ sources:{}, upstream:JSON.parse(await fs.readFile(path.join(root,'public/holo-effects/source/manifest.json'),'utf8')) }
for (const file of sources) provenance.sources[file]=crypto.createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')
await fs.writeFile(path.join(outDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n')
