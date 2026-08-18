import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const portMappings = [
  {
    service: 'backend',
    variable: 'BACKEND_PORT',
    published: '${BACKEND_PORT:-8000}',
    unsafePublished: '${BACKEND_PORT-8000}',
    container: '8000',
  },
  {
    service: 'frontend',
    variable: 'FRONTEND_PORT',
    published: '${FRONTEND_PORT:-3000}',
    unsafePublished: '${FRONTEND_PORT-3000}',
    container: '80',
  },
]

function isIgnorable(line) {
  return line.trim() === '' || line.trim().startsWith('#')
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

// Returns the lines belonging to `services:`, so a service-shaped block parked
// under a top-level extension cannot be mistaken for a real service.
function servicesLines(compose) {
  const lines = compose.split('\n')
  const start = lines.findIndex((line) => /^services:\s*(?:#.*)?$/u.test(line))
  if (start === -1) {
    return null
  }

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !isIgnorable(line) && indentOf(line) === 0)
  return end === -1 ? rest : rest.slice(0, end)
}

function serviceLines(lines, service) {
  const start = lines.findIndex((line) => new RegExp(`^ {2}${service}:\\s*(?:#.*)?$`, 'u').test(line))
  if (start === -1) {
    return null
  }

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !isIgnorable(line) && indentOf(line) <= 2)
  return end === -1 ? rest : rest.slice(0, end)
}

// Only the entries of the service's own `ports:` list. Anything under another
// key, including an ignored `x-` extension, is not a published port.
function portEntries(lines) {
  const start = lines.findIndex((line) => /^ {4}ports:\s*(?:#.*)?$/u.test(line))
  if (start === -1) {
    return null
  }

  const entries = []
  for (const line of lines.slice(start + 1)) {
    if (isIgnorable(line)) {
      continue
    }
    if (indentOf(line) <= 4) {
      break
    }

    const entry = line.match(/^ {6}- (.*?)\s*(?:#.*)?$/u)?.[1]
    if (entry !== undefined) {
      entries.push(entry)
    }
  }

  return entries
}

export function checkComposePorts(compose) {
  const errors = []
  const services = servicesLines(compose)

  if (services === null) {
    return ['docker-compose.yml is missing the services section']
  }

  for (const mapping of portMappings) {
    const block = serviceLines(services, mapping.service)
    if (block === null) {
      errors.push(`docker-compose.yml is missing the ${mapping.service} service`)
      continue
    }

    const entries = portEntries(block)
    if (entries === null) {
      errors.push(`${mapping.service} does not publish any ports`)
      continue
    }

    if (entries.includes(`"${mapping.published}:${mapping.container}"`)) {
      continue
    }

    if (entries.includes(`"${mapping.unsafePublished}:${mapping.container}"`)) {
      errors.push(
        `${mapping.service} must use ${mapping.published}:${mapping.container}; ${mapping.unsafePublished} is wrong because an empty variable loses the stable default host port and may receive an ephemeral one`,
      )
      continue
    }

    errors.push(
      `Expected ${mapping.service} to publish "${mapping.published}:${mapping.container}" in its ports list, in quoted short syntax`,
    )
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
