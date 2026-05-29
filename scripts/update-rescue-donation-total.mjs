import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const donationsPath = resolve(root, 'RESCUE_DONATIONS.csv')
const readmePath = resolve(root, 'README.md')

function parseCsvLine(line) {
  const cells = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '"' && quoted && next === '"') {
      value += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      cells.push(value)
      value = ''
    } else {
      value += char
    }
  }
  cells.push(value)
  return cells
}

function parseAmount(value) {
  const cleaned = String(value || '0').trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return 0
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatAmount(amount, currency) {
  const fixed = amount.toFixed(2)
  if (currency === 'EUR') return `€${fixed}`
  if (currency === 'USD') return `$${fixed}`
  if (currency === 'GBP') return `£${fixed}`
  return `${fixed} ${currency}`
}

const csv = readFileSync(donationsPath, 'utf8').trim()
const lines = csv ? csv.split(/\r?\n/) : []
const headers = lines.length ? parseCsvLine(lines[0]).map(header => header.trim()) : []
const requiredHeaders = ['date', 'amount', 'currency', 'organization', 'url', 'note']
const missingHeaders = requiredHeaders.filter(header => !headers.includes(header))
if (missingHeaders.length) {
  throw new Error(`RESCUE_DONATIONS.csv is missing required header(s): ${missingHeaders.join(', ')}`)
}

const amountIndex = headers.indexOf('amount')
const currencyIndex = headers.indexOf('currency')

let total = 0
let currency = 'EUR'
let count = 0
for (const line of lines.slice(1)) {
  if (!line.trim()) continue
  const cells = parseCsvLine(line)
  const amount = parseAmount(cells[amountIndex])
  if (amount <= 0) continue
  const rowCurrency = (cells[currencyIndex] || 'EUR').trim().toUpperCase() || 'EUR'
  total += amount
  count += 1
  if (count === 1) currency = rowCurrency
  else if (currency !== rowCurrency) currency = 'MIXED'
}

const replacement = `<!-- rescue-donation-total:start -->\n**Animal rescue donations sent so far:** ${formatAmount(total, currency)}\n<!-- rescue-donation-total:end -->`
const readme = readFileSync(readmePath, 'utf8')
const updated = readme.replace(
  /<!-- rescue-donation-total:start -->[\s\S]*?<!-- rescue-donation-total:end -->/,
  replacement,
)

if (updated === readme && !readme.includes('<!-- rescue-donation-total:start -->')) {
  throw new Error('README rescue donation total marker not found')
}

writeFileSync(readmePath, updated)
console.log(`Updated README rescue donation total to ${formatAmount(total, currency)}.`)
