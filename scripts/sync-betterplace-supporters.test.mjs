import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  buildBetterplaceRecords,
  extractPublicName,
  fetchCampaignOpinions,
  mergeSupportersCsv,
  parseCsv,
} from './sync-betterplace-supporters.mjs'

const eligibleOpinion = {
  id: 123,
  message: 'POKECOLLECTOR: CardCollector42',
  author: { name: 'Public donor' },
  confirmed_at: '2026-08-13T18:00:00+02:00',
  donated_amount_in_cents: 2500,
}

test('extractPublicName requires the explicit prefix and validates CSV-safe names', () => {
  assert.equal(extractPublicName('POKECOLLECTOR: CardCollector42'), 'CardCollector42')
  assert.equal(extractPublicName('  POKECOLLECTOR:  Card Collector 42  '), 'Card Collector 42')
  assert.equal(extractPublicName('POKECOLLECTOR: CardCollector42\nThank you for the project'), 'CardCollector42')
  assert.equal(extractPublicName('CardCollector42'), null)
  assert.equal(extractPublicName('POKECOLLECTOR: =HYPERLINK("bad")'), null)
  assert.equal(extractPublicName('POKECOLLECTOR: \u202e=HYPERLINK("bad")'), null)
  assert.equal(extractPublicName(`POKECOLLECTOR: ${'x'.repeat(61)}`), null)
})

test('only confirmed, non-anonymous, explicitly opted-in donations are imported', () => {
  const rows = buildBetterplaceRecords([
    eligibleOpinion,
    { ...eligibleOpinion, id: 124, author: null },
    { ...eligibleOpinion, id: 125, confirmed_at: null },
    { ...eligibleOpinion, id: 126, message: 'Thank you' },
  ])

  assert.deepEqual(rows, [{
    date: '',
    name: 'CardCollector42',
    amount: '',
    currency: 'EUR',
    url: '',
    source: 'betterplace:57435',
  }])
})

test('merge preserves legacy supporters and replaces only campaign-managed rows', () => {
  const existing = [
    'date,name,amount,currency,url,source',
    '2026-05-29,Legacy,10,EUR,https://example.com,',
    ',Old imported,,EUR,,betterplace:57435',
    '',
  ].join('\n')

  const merged = mergeSupportersCsv(existing, [eligibleOpinion])
  const { records } = parseCsv(merged)
  assert.equal(records.length, 2)
  assert.equal(records[0].name, 'Legacy')
  assert.equal(records[1].name, 'CardCollector42')
  assert.equal(records[1].amount, '')
  assert.equal(records[1].source, 'betterplace:57435')
})

test('merge refuses to wipe imported supporters when no eligible opt-ins remain', () => {
  const existing = [
    'date,name,amount,currency,url,source',
    ',Imported supporter,,EUR,,betterplace:57435',
    '',
  ].join('\n')

  assert.throws(
    () => mergeSupportersCsv(existing, []),
    /refusing to remove existing imported supporters/,
  )
  assert.throws(
    () => mergeSupportersCsv(existing, [{
      ...eligibleOpinion,
      message: 'A public donation without the explicit opt-in prefix',
    }]),
    /refusing to remove existing imported supporters/,
  )
})

test('merge rejects malformed CSV headers instead of rewriting ambiguous data', () => {
  assert.throws(
    () => mergeSupportersCsv('date,amount\n2026-08-14,10\n', []),
    /missing the name header/,
  )
  assert.throws(
    () => parseCsv('date,name,name\n2026-08-14,Alice,Alice\n'),
    /duplicate headers/,
  )
  assert.throws(
    () => parseCsv('date,name\n2026-08-14,Alice,unexpected\n'),
    /more values than headers/,
  )
})

test('fetchCampaignOpinions follows pagination and rejects malformed payloads', async () => {
  const pages = []
  const fetchImpl = async (url) => {
    pages.push(url.searchParams.get('page'))
    const page = Number(url.searchParams.get('page'))
    return {
      ok: true,
      json: async () => ({ current_page: page, data: [{ id: page }], total_pages: 2, total_entries: 2 }),
    }
  }

  const result = await fetchCampaignOpinions({ fetchImpl })
  assert.deepEqual(pages, ['1', '2'])
  assert.deepEqual(result, [{ id: 1 }, { id: 2 }])

  await assert.rejects(
    () => fetchCampaignOpinions({ fetchImpl: async () => ({ ok: true, json: async () => ({ wrong: [] }) }) }),
    /Unexpected Betterplace API response shape/,
  )
})

test('fetchCampaignOpinions rejects duplicate and changing pagination snapshots', async () => {
  await assert.rejects(
    () => fetchCampaignOpinions({
      fetchImpl: async (url) => ({
        ok: true,
        json: async () => ({
          current_page: Number(url.searchParams.get('page')),
          data: [{ id: 1 }],
          total_pages: 2,
          total_entries: 2,
        }),
      }),
    }),
    /repeated entry ID 1/,
  )

  await assert.rejects(
    () => fetchCampaignOpinions({
      fetchImpl: async (url) => {
        const page = Number(url.searchParams.get('page'))
        return {
          ok: true,
          json: async () => ({
            current_page: page,
            data: [{ id: page }],
            total_pages: page === 1 ? 2 : 3,
            total_entries: 2,
          }),
        }
      },
    }),
    /pagination changed/,
  )
})

test('scheduled sync publishes a review branch instead of pushing to main', async () => {
  const workflowUrl = new URL('../.github/workflows/sync-betterplace-supporters.yml', import.meta.url)
  const workflow = await readFile(workflowUrl, 'utf8')

  assert.match(workflow, /pull-requests:\s*write/u)
  assert.match(workflow, /ref:\s*main/u)
  assert.match(workflow, /gh pr create/u)
  assert.match(workflow, /HEAD:refs\/heads\/\$UPDATE_BRANCH/u)
  assert.doesNotMatch(workflow, /^\s+git push\s*$/mu)
})
