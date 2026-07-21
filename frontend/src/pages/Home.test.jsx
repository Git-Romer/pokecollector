import { describe, expect, it } from 'vitest'
import en from '../i18n/en'

// The overview copy used to live in a constant exported from Home.jsx. It is
// now in the i18n layer so the landing surface can be translated, but the
// guard it carried still matters and is asserted against that source instead.
const overview = en.archive

describe('Collection Overview copy', () => {
  it('uses Collection Overview language for the root surface', () => {
    expect(overview.kicker).toBe('COLLECTION OVERVIEW')
    expect(overview.title).toBe('Collection Overview')
    expect(overview.notesTitle).toBe('John John’s Notes')
  })

  it('keeps finance language off the landing surface', () => {
    // The spec makes this an unpriced surface; price belongs in card detail.
    expect(Object.values(overview).join(' ')).not.toMatch(/portfolio|P&L|market|profit/i)
  })

  it('calls the collection by one name', () => {
    // Archive and Databank were competing nouns for the same thing.
    expect(Object.values(overview).join(' ')).not.toMatch(/\barchive\b|\bdatabank\b/i)
  })

  it('keeps placeholders intact on the interpolated strings', () => {
    expect(overview.lastFiled).toContain('{name}')
    expect(overview.cardsLeft).toContain('{count}')
    expect(overview.filedOfTotal).toContain('{owned}')
    expect(overview.filedOfTotal).toContain('{total}')
  })
})
