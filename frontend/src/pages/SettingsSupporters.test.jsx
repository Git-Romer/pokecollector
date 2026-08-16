import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { supporterQueryOptions, SupportersPanel } from './Settings'


const translations = {
  'settings.noSupportersYet': 'No supporters',
  'settings.supportersUnavailable': 'Supporters unavailable',
  'settings.supporterDonation': 'donation',
  'settings.supporterDonations': 'donations',
  'settings.latestSupport': 'Latest support',
}

const t = key => translations[key] || key

const supporter = {
  name: 'Example Trainer',
  url: 'https://example.org/profile',
  crown: 'gold',
  support: {
    total_amount_cents: 1050,
    currency: 'EUR',
    donation_count: 2,
    latest_supported_on: '2026-08-16',
  },
}

describe('SupportersPanel', () => {
  it('renders the public v1 support fields', () => {
    const html = renderToStaticMarkup(<SupportersPanel supporters={[supporter]} t={t} />)
    expect(html).toContain('Example Trainer')
    expect(html).toContain('€10.50')
    expect(html).toContain('2 donations')
    expect(html).toContain('2026-08-16')
  })

  it('immediately hides stale supporter data after a refresh failure', () => {
    const html = renderToStaticMarkup(
      <SupportersPanel supporters={[supporter]} unavailable t={t} />,
    )
    expect(html).toContain('Supporters unavailable')
    expect(html).not.toContain('Example Trainer')
  })

  it('marks a rejected refetch unavailable even while TanStack retains old data', async () => {
    let calls = 0
    const queryFn = () => {
      calls += 1
      return calls === 1 ? Promise.resolve([supporter]) : Promise.reject(new Error('offline'))
    }
    const queryClient = new QueryClient()
    const observer = new QueryObserver(queryClient, supporterQueryOptions(queryFn))
    const initial = await observer.refetch()
    expect(initial.data).toEqual([supporter])

    const failed = await observer.refetch()
    expect(failed.data).toEqual([supporter])
    expect(failed.isError || failed.isRefetchError).toBe(true)
    const html = renderToStaticMarkup(
      <SupportersPanel
        supporters={failed.data}
        unavailable={failed.isError || failed.isRefetchError}
        t={t}
      />,
    )
    expect(html).toContain('Supporters unavailable')
    expect(html).not.toContain('Example Trainer')
    queryClient.clear()
  })

  it('keeps a valid empty registry distinct from an outage', () => {
    const html = renderToStaticMarkup(<SupportersPanel supporters={[]} t={t} />)
    expect(html).toContain('No supporters')
    expect(html).not.toContain('Supporters unavailable')
  })
})
