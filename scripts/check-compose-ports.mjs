import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const portMappings = [
  {
    service: 'backend',
    published: '${BACKEND_PORT:-8000}',
    unsafePublished: '${BACKEND_PORT-8000}',
    container: '8000',
  },
  {
    service: 'frontend',
    published: '${FRONTEND_PORT:-3000}',
    unsafePublished: '${FRONTEND_PORT-3000}',
    container: '80',
  },
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function serviceBlock(compose, service) {
  const pattern = new RegExp(
    `^ {2}${escapeRegExp(service)}:\\s*(?:#.*)?$([\\s\\S]*?)(?=^ {2}[^\\s][^:\\n]*:\\s*(?:#.*)?$|^[^\\s#][^:\\n]*:\\s*(?:#.*)?$|(?![\\s\\S]))`,
    'mu',
  )
  return compose.match(pattern)?.[1] ?? null
}

function hasPortMapping(block, published, container) {
  // Matches the mapping wherever it sits in the ports list, so adding another
  // published port above it stays valid.
  const pattern = new RegExp(
    `^ {6}- "${escapeRegExp(published)}:${escapeRegExp(container)}"\\s*(?:#.*)?$`,
    'mu',
  )
  return pattern.test(block)
}

export function checkComposePorts(compose) {
  const errors = []

  for (const mapping of portMappings) {
    const block = serviceBlock(compose, mapping.service)
    if (block === null) {
      errors.push(`docker-compose.yml is missing the ${mapping.service} service`)
      continue
    }

    if (hasPortMapping(block, mapping.published, mapping.container)) {
      continue
    }

    if (hasPortMapping(block, mapping.unsafePublished, mapping.container)) {
      errors.push(
        `${mapping.service} must use ${mapping.published}:${mapping.container}; ${mapping.unsafePublished} is wrong because an empty variable silently leaves the port unpublished`,
      )
      continue
    }

    errors.push(`Expected ${mapping.service} to publish ${mapping.published}:${mapping.container}`)
  }

  return errors
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8')
  const errors = checkComposePorts(compose)

  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  console.log('Compose port mappings are correct.')
}
