import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArtistGalleryTile, artistHref, parseArtistsState } from './Artists'

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useSearchParams: vi.fn(),
}))
vi.mock('../components/CardImage', () => ({
  default: ({ src, alt, className }) => <img src={src} alt={alt} className={className} />,
}))

const t = key => ({
  'artists.ownedOf': 'owned', 'artists.missing': '{count} missing',
  'artists.progress': 'Progress for {artist}', 'artists.featuredCards': 'Featured cards',
}[key] || key)
const artist = {
  name: 'Test & Artist', total_count: 24, owned_count: 17, missing_count: 7, progress: 70.8,
  preview_cards: [1, 2, 3].map(n => ({ id: `me03-${n}_en`, tcg_card_id: `me03-${n}`, name: `Card ${n}`, valuation: { amount: n === 3 ? null : 4 - n } })),
}
const render = (value = artist) => renderToStaticMarkup(<ArtistGalleryTile artist={value} lang="de" t={t} formatPrice={v => `EUR ${v}`} />)

describe('artist gallery', () => {
  it('defaults to completion descending when no sorting is specified', () => {
    expect(parseArtistsState(new URLSearchParams())).toMatchObject({ sortBy: 'progress', sortOrder: 'desc' })
  })
  it('preserves explicitly selected name and ascending sorting', () => {
    expect(parseArtistsState(new URLSearchParams('sort_by=name&sort_order=asc'))).toMatchObject({ sortBy: 'name', sortOrder: 'asc' })
  })
  it('renders three card artworks, a name link and compact real progress', () => {
    const html = render()
    expect((html.match(/<img /g) || []).length).toBe(3)
    expect(html).toContain('object-contain')
    expect(html).toContain('17 / 24')
    expect(html).toContain('7 missing')
    expect(html).toContain('aria-valuenow="70.8"')
    expect(html).toContain('/artist/Test%20%26%20Artist?lang=de')
  })
  it('does not present missing prices as zero', () => {
    const html = render()
    expect(html).toContain('Card 1 · EUR 3')
    expect(html).toContain('title="Card 3"')
    expect(html).not.toContain('EUR 0')
  })
  it('does not duplicate artwork for an artist with only one card', () => {
    expect((render({ ...artist, preview_cards: artist.preview_cards.slice(0, 1) }).match(/<img /g) || []).length).toBe(1)
  })
  it('keeps a missing preview payload usable', () => {
    expect(render({ ...artist, preview_cards: undefined })).toContain('role="progressbar"')
  })
  it('clamps invalid progress for accessible progress bars', () => {
    expect(render({ ...artist, progress: 900 })).toContain('aria-valuenow="100"')
    expect(render({ ...artist, progress: Number.NaN })).toContain('aria-valuenow="0"')
  })
  it('retains correct escaping and language routing in both layouts', () => {
    expect(artistHref('A/B + C', 'en')).toBe('/artist/A%2FB%20%2B%20C?lang=en')
    expect(artistHref('A/B + C')).toBe('/artist/A%2FB%20%2B%20C')
  })
  it('does not change search, sorting or pagination when the view changes', () => {
    const before = new URLSearchParams('q=Arita&lang=de&page=2&sort_by=cards&sort_order=desc')
    const after = new URLSearchParams(before)
    after.set('view', 'list')
    expect(parseArtistsState(after)).toEqual(parseArtistsState(before))
  })
})
