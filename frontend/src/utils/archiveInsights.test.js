import {deriveArchiveInsights} from './archiveInsights'

test('creates a near-completion note without price analysis', () => {
    const notes = deriveArchiveInsights({
        totalCards: 42,
        recentAdditions: [],
        sets: [{id: 'sv1', name: 'Scarlet & Violet', owned_count: 196, total: 198}]
    })
    expect(notes[0]).toMatchObject({
        kind: 'near-completion',
        body: 'Only 2 cards left in Scarlet & Violet.',
        href: '/all-cards/sv1'
    })
})
