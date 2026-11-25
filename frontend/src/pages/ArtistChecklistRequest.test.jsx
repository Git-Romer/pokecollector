import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const query = vi.hoisted(() => ({ options: null, search: 'lang=de', primary: 'avg7', cards: [] }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: options => { query.options = options; return { data: { cards: query.cards, artists: [], total_count: query.cards.length, page: 1, page_size: 60 } } },
  useQueryClient: () => ({}),
  useMutation: () => ({}),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ to, children }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ artistName: 'Mitsuhiro Arita' }),
  useSearchParams: () => [new URLSearchParams(query.search), vi.fn()],
}))
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key, formatPrice: String, settings: { price_primary: query.primary } }),
}))
vi.mock('../components/CardItem', () => ({ CardModal: () => null }))
vi.mock('../components/card-system', () => ({ CardDisplay: ({ price }) => <span>{price || 'unpriced'}</span> }))
vi.mock('../components/WindowedCardGrid', () => ({ default: ({ items, renderItem }) => <div>{items.map(renderItem)}</div> }))
import ArtistChecklist from './ArtistChecklist'

it('renders the selected shared EUR quote instead of the raw market price', () => {
  query.cards = [{ id: 'quoted_en', lang: 'en', price_market: 5.15, price_trend: 4.85, price_avg7: 6.5 }];
  try { expect(renderToStaticMarkup(<ArtistChecklist />)).toContain('<span>6.5</span>') }
  finally { query.cards = [] }
})

it('converts an eligible fallback and leaves an unconvertible quote unpriced', () => {
  query.cards = [
    { id: 'converted_en', lang: 'en', price_tcg_normal_market: 10, price_tcg_usd_to_eur: 0.9 },
    { id: 'unconverted_en', lang: 'en', price_tcg_normal_market: 100 },
  ];
  try {
    const html = renderToStaticMarkup(<ArtistChecklist />);
    expect(html).toContain('<span>9</span>');
    expect(html).toContain('<span>unpriced</span>');
  } finally { query.cards = [] }
})

it('maps the avg setting to the canonical market field', () => {
  query.primary = 'avg';
  try {
    renderToStaticMarkup(<ArtistChecklist />);
    expect(query.options.queryKey[1].price_field).toBe('price_market');
  } finally { query.primary = 'avg7' }
})


it('preserves an explicitly requested multi-artist substring checklist from search', () => {
  query.search = 'artist_match=contains';
  try {
    renderToStaticMarkup(<ArtistChecklist />)
    expect(query.options.queryKey[1].artist_match).toBe('contains')
  } finally { query.search = 'lang=de' }
})


it('requests the exact artist, selected language and shared price preference', () => {
  renderToStaticMarkup(<ArtistChecklist />)
  expect(query.options.queryKey[1]).toMatchObject({
    artist: 'Mitsuhiro Arita', artist_match: 'exact', lang: 'de', price_field: 'price_avg7',
  })
})
