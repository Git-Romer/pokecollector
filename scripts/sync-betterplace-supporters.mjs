import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_CAMPAIGN_ID = '57435'
export const SOURCE_PREFIX = 'betterplace'
export const DEFAULT_API_BASE_URL = 'https://api.betterplace.org/de/api_v4'
export const REQUIRED_HEADERS = ['date', 'name', 'amount', 'currency', 'url', 'source']

function publicNameKey(name) {
  return String(name ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

function opinionId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value.trim())) return value.trim()
  throw new Error('Betterplace returned an entry with an invalid ID')
}

export function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '"' && quoted && next === '"') {
      value += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1
      row.push(value)
      value = ''
      if (row.some(cell => cell.length > 0)) rows.push(row)
      row = []
    } else {
      value += char
    }
  }

  if (quoted) throw new Error('SUPPORTERS.csv contains an unterminated quoted value')
  if (value.length || row.length) {
    row.push(value)
    if (row.some(cell => cell.length > 0)) rows.push(row)
  }
  if (!rows.length) return { headers: [], records: [] }

  const headers = rows[0].map(header => header.trim())
  if (headers.some(header => !header)) {
    throw new Error('SUPPORTERS.csv contains an empty header')
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error('SUPPORTERS.csv contains duplicate headers')
  }
  const records = rows.slice(1).map((cells, rowIndex) => {
    if (cells.length > headers.length) {
      throw new Error(`SUPPORTERS.csv row ${rowIndex + 2} has more values than headers`)
    }
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']))
  })
  return { headers, records }
}

function escapeCsv(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function writeCsv(headers, records) {
  const lines = [headers.map(escapeCsv).join(',')]
  for (const record of records) {
    lines.push(headers.map(header => escapeCsv(record[header] || '')).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function extractPublicName(message) {
  if (typeof message !== 'string') return null
  const match = message.match(/^[ \t]*POKECOLLECTOR:[ \t]*([^\r\n]+?)[ \t]*(?:\r?\n|$)/iu)
  if (!match) return null

  const name = match[1]
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

  if (!name || [...name].length > 60) return null
  if (/^[=+\-@]/u.test(name)) return null
  return name
}

export function buildBetterplaceRecords(opinions, campaignId = DEFAULT_CAMPAIGN_ID) {
  if (!Array.isArray(opinions)) throw new Error('Betterplace response did not contain a donation list')
  const seenIds = new Set()
  const seenNames = new Set()
  const records = []

  for (const opinion of opinions) {
    const id = opinionId(opinion?.id)
    if (seenIds.has(id)) throw new Error(`Betterplace returned duplicate entry ID ${id}`)
    seenIds.add(id)

    if (opinion?.message != null && typeof opinion.message !== 'string') {
      throw new Error(`Betterplace entry ${id} contains an invalid message`)
    }
    if (opinion?.author != null && (typeof opinion.author !== 'object' || Array.isArray(opinion.author))) {
      throw new Error(`Betterplace entry ${id} contains an invalid author`)
    }
    if (opinion?.author?.name != null && typeof opinion.author.name !== 'string') {
      throw new Error(`Betterplace entry ${id} contains an invalid author name`)
    }
    if (opinion?.confirmed_at != null && typeof opinion.confirmed_at !== 'string') {
      throw new Error(`Betterplace entry ${id} contains an invalid confirmation date`)
    }

    const publicName = extractPublicName(opinion?.message)
    const hasPublicAuthor = typeof opinion?.author?.name === 'string' && Boolean(opinion.author.name.trim())
    const isConfirmed = typeof opinion?.confirmed_at === 'string' && Boolean(opinion.confirmed_at.trim())
    const nameKey = publicName ? publicNameKey(publicName) : null
    if (!publicName || seenNames.has(nameKey) || !hasPublicAuthor || !isConfirmed) continue

    seenNames.add(nameKey)
    records.push({
      date: '',
      name: publicName,
      amount: '',
      currency: 'EUR',
      url: '',
      source: `${SOURCE_PREFIX}:${campaignId}`,
    })
  }

  return records.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }))
}

export function mergeSupportersCsv(existingCsv, opinions, campaignId = DEFAULT_CAMPAIGN_ID) {
  const { headers: existingHeaders, records: existingRecords } = parseCsv(existingCsv)
  if (!existingHeaders.includes('name')) {
    throw new Error('SUPPORTERS.csv is missing the name header')
  }
  const headers = [...existingHeaders]
  for (const header of REQUIRED_HEADERS) {
    if (!headers.includes(header)) headers.push(header)
  }

  const source = `${SOURCE_PREFIX}:${campaignId}`
  const managed = existingRecords.filter(record => record.source === source)
  const preserved = existingRecords.filter(record => record.source !== source)
  const imported = buildBetterplaceRecords(opinions, campaignId)

  const managedNames = new Set(managed.map(record => publicNameKey(record.name)))
  if (managedNames.has('')) {
    throw new Error('SUPPORTERS.csv contains a managed Betterplace row without a public name')
  }
  const importedNames = new Set(imported.map(record => publicNameKey(record.name)))
  const missingManagedNames = [...managedNames].filter(name => !importedNames.has(name))
  if (missingManagedNames.length > 0) {
    throw new Error('Betterplace omitted existing public opt-ins; refusing to remove imported supporters automatically')
  }

  const preservedNames = new Set(preserved.map(record => publicNameKey(record.name)).filter(Boolean))
  const nonDuplicateImports = imported.filter(record => !preservedNames.has(publicNameKey(record.name)))
  return writeCsv(headers, [...preserved, ...nonDuplicateImports])
}

export async function fetchCampaignOpinions({
  campaignId = DEFAULT_CAMPAIGN_ID,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const allOpinions = []
  const seenIds = new Set()
  let page = 1
  let totalPages = null
  let totalEntries = null

  do {
    const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/fundraising_events/${campaignId}/opinions.json`)
    url.searchParams.set('page', String(page))
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Pokecollector-supporter-sync/1.0' },
    })
    if (!response.ok) throw new Error(`Betterplace returned HTTP ${response.status}`)
    const payload = await response.json()
    if (!payload || !Array.isArray(payload.data)) throw new Error('Unexpected Betterplace API response shape')

    if (payload.current_page !== undefined && Number(payload.current_page) !== page) {
      throw new Error('Betterplace returned an unexpected page number')
    }
    for (const opinion of payload.data) {
      const id = opinionId(opinion?.id)
      if (seenIds.has(id)) {
        throw new Error(`Betterplace pagination repeated entry ID ${id}`)
      }
      seenIds.add(id)
      allOpinions.push(opinion)
    }
    const pageTotalEntries = Number(payload.total_entries || 0)
    if (!Number.isInteger(pageTotalEntries) || pageTotalEntries < 0) {
      throw new Error('Unexpected Betterplace entry count')
    }
    if (totalEntries !== null && totalEntries !== pageTotalEntries) {
      throw new Error('Betterplace pagination changed while the feed was being read')
    }
    totalEntries = pageTotalEntries
    const pageTotalPages = Number(payload.total_pages || 0)
    if (!Number.isInteger(pageTotalPages) || pageTotalPages < 0 || pageTotalPages > 100) {
      throw new Error('Unexpected Betterplace pagination metadata')
    }
    if (totalPages !== null && totalPages !== pageTotalPages) {
      throw new Error('Betterplace pagination changed while the feed was being read')
    }
    totalPages = pageTotalPages
    page += 1
  } while (page <= (totalPages ?? 0))

  if (allOpinions.length !== totalEntries) {
    throw new Error(`Betterplace returned ${allOpinions.length} of ${totalEntries} expected entries`)
  }

  return allOpinions
}

export async function main() {
  const campaignId = process.env.BETTERPLACE_CAMPAIGN_ID || DEFAULT_CAMPAIGN_ID
  const apiBaseUrl = process.env.BETTERPLACE_API_BASE_URL || DEFAULT_API_BASE_URL
  const supportersPath = resolve(process.env.SUPPORTERS_PATH || 'SUPPORTERS.csv')
  const dryRun = process.argv.includes('--dry-run')
  const existingCsv = await readFile(supportersPath, 'utf8')
  const opinions = await fetchCampaignOpinions({ campaignId, apiBaseUrl })
  const updatedCsv = mergeSupportersCsv(existingCsv, opinions, campaignId)

  if (updatedCsv === existingCsv) {
    console.log(`Supporter list is already current (${opinions.length} campaign entries checked).`)
    return
  }
  if (dryRun) {
    console.log(`Dry run: SUPPORTERS.csv would change after checking ${opinions.length} public campaign entries.`)
    return
  }

  await writeFile(supportersPath, updatedCsv)
  console.log(`Updated SUPPORTERS.csv from Betterplace campaign ${campaignId}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error.message || error)
    process.exitCode = 1
  })
}
