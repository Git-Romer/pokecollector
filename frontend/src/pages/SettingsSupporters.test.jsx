import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { supporterQueryOptions, summarizeSupporters, SupportersPanel } from './Settings'


const translations = {
  'settings.noSupportersYet': 'No supporters',
  'settings.supportersUnavailable': 'Supporters unavailable',
  'settings.supporterDonation': 'donation',
  'settings.supporterDonations': 'donations',
  'settings.supporter': 'supporter',
  'settings.supporterPlural': 'supporters',
  'settings.supporters': 'supporters',
  'settings.totalSupport': 'total support',
  'settings.mixedCurrencySupport': 'plus mixed-currency support',
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
  it('summarizes supporter, donation, and per-currency amount totals exactly', () => {
    const summary = summarizeSupporters([
      supporter,
      {
        ...supporter,
        name: 'Second Trainer',
        support: {
          total_amount_cents: 250,
          currency: 'USD',
          donation_count: 1,
          latest_supported_on: null,
        },
      },
      { ...supporter, name: 'Manual Trainer', support: null },
      {
        ...supporter,
        name: 'Mixed Trainer',
        support: {
          total_amount_cents: 500,
          currency: 'MIXED',
          donation_count: 3,
          latest_supported_on: null,
        },
      },
    ])

    expect(summary).toEqual({
      supporterCount: 4,
      donationCount: 6n,
      amountTotals: [
        { currency: 'EUR', amountCents: 1050n },
        { currency: 'USD', amountCents: 250n },
      ],
      hasMixedCurrency: true,
    })
  })

  it('keeps totals exact when individually safe amounts exceed the safe range together', () => {
    const summary = summarizeSupporters([
      {
        ...supporter,
        name: 'First Trainer',
        support: {
          total_amount_cents: Number.MAX_SAFE_INTEGER,
          currency: 'EUR',
          donation_count: Number.MAX_SAFE_INTEGER,
          latest_supported_on: null,
        },
      },
      {
        ...supporter,
        name: 'Second Trainer',
        support: {
          total_amount_cents: Number.MAX_SAFE_INTEGER,
          currency: 'EUR',
          donation_count: Number.MAX_SAFE_INTEGER,
          latest_supported_on: null,
        },
      },
    ])

    expect(summary.donationCount).toBe(18014398509481982n)
    expect(summary.amountTotals).toEqual([
      { currency: 'EUR', amountCents: 18014398509481982n },
    ])
  })

  it('renders supporter, donation, and currency-safe totals above the cards', () => {
    const html = renderToStaticMarkup(
      <SupportersPanel
        supporters={[
          supporter,
          {
            ...supporter,
            name: 'Second Trainer',
            support: {
              total_amount_cents: 250,
              currency: 'USD',
              donation_count: 1,
              latest_supported_on: null,
            },
          },
        ]}
        t={t}
      />,
    )
    expect(html).toContain('2</strong> supporters')
    expect(html).toContain('3</strong> donations')
    expect(html).toContain('€10.50 + $2.50')
    expect(html).toContain('total support')
  })

  it('labels mixed-currency support without presenting it as a combined total', () => {
    const html = renderToStaticMarkup(
      <SupportersPanel
        supporters={[
          {
            ...supporter,
            support: {
              total_amount_cents: 500,
              currency: 'MIXED',
              donation_count: 1,
              latest_supported_on: null,
            },
          },
        ]}
        t={t}
      />,
    )
    expect(html).toContain('plus mixed-currency support')
    expect(html).not.toContain('total support')
  })

  it('disables every automatic refetch trigger while retaining the in-memory session cache', () => {
    const options = supporterQueryOptions(() => Promise.resolve([]))
    expect(options.enabled).toBe(false)
    expect(options.gcTime).toBe(Infinity)
    expect(options.refetchInterval).toBe(false)
    expect(options.refetchIntervalInBackground).toBe(false)
    expect(options.refetchOnMount).toBe(false)
    expect(options.refetchOnWindowFocus).toBe(false)
    expect(options.refetchOnReconnect).toBe(false)
  })

  it('fetches only when explicitly requested on entry and ignores broad invalidation', async () => {
    let calls = 0
    const queryFn = async () => {
      calls += 1
      return [{ ...supporter, name: `Entry ${calls}` }]
    }
    const queryClient = new QueryClient()
    const observer = new QueryObserver(queryClient, supporterQueryOptions(queryFn))
    const unsubscribe = observer.subscribe(() => {})

    await Promise.resolve()
    expect(calls).toBe(0)

    const first = await observer.refetch()
    expect(calls).toBe(1)
    expect(first.data[0].name).toBe('Entry 1')

    await queryClient.invalidateQueries()
    expect(calls).toBe(1)
    expect(queryClient.getQueryData(['supporters'])[0].name).toBe('Entry 1')

    const second = await observer.refetch()
    expect(calls).toBe(2)
    expect(second.data[0].name).toBe('Entry 2')

    unsubscribe()
    queryClient.clear()
  })

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

  it('does not expose cached names while a page-entry refresh is pending', () => {
    const html = renderToStaticMarkup(
      <SupportersPanel supporters={[supporter]} isLoading t={t} />,
    )
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
