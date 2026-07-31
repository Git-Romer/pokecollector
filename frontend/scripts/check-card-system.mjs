import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = resolve(frontendRoot, 'src')
const allowedLegacyInternals = new Set([
  'components/CardItem.jsx',
  'components/CardListItem.jsx',
  'components/CardStateIndicators.jsx',
  'components/UnifiedCard.jsx',
])

const forbidden = [
  {
    pattern: /from\s+['"][^'"]*(?:UnifiedCard|CardListItem|CardStateIndicators)['"]/, 
    message: 'Import card UI from components/card-system instead of a legacy internal module.',
  },
  {
    pattern: /<(?:UnifiedCard|UnifiedCardDialog|CardArtworkFrame|CompactCardArtwork|CompactCardIdentity|CardListItem|CardStateLegend(?:Disclosure)?)\b/,
    message: 'Use CardDisplay, CardRow, CardIdentity, CardDialog, or CardLegend from components/card-system.',
  },
  {
    pattern: /unified-card-(?:frame|art|caption|selection|unavailable)/,
    message: 'Card-system CSS internals must not be assembled in feature code.',
  },
  {
    pattern: /<img\b[^>]*\bsrc=\{[^}]*(?:\.image\b|resolveCardImageUrl\()/s,
    message: 'Render card artwork through components/card-system so shared loading and error states are preserved.',
  },
]

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path)
    return ['.css', '.js', '.jsx'].includes(extname(entry.name)) ? [path] : []
  })
}

const errors = []
for (const file of collectFiles(sourceRoot)) {
  const path = relative(sourceRoot, file).replaceAll('\\', '/')
  if (path.includes('/card-system/') || path.endsWith('.test.js') || path.endsWith('.test.jsx') || allowedLegacyInternals.has(path)) continue
  const source = readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) errors.push(`${path}: ${rule.message}`)
  }
}

if (errors.length > 0) {
  console.error('Card-system boundary check failed:\n')
  for (const error of errors) console.error(`- ${error}`)
  console.error('\nNew visual ideas are welcome. Add a shared variant to components/card-system and document it in docs/CARD_SYSTEM.md.')
  process.exit(1)
}

console.log('Card-system boundary check passed.')
