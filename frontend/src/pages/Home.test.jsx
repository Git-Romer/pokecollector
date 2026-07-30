import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {render, screen} from '@testing-library/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import {describe, expect, it, vi} from 'vitest'
import en from '../i18n/en'
import Home from './Home'

vi.mock('../api/client', () => ({
    getDashboard: vi.fn(() => Promise.resolve({
        data: {
            total_cards: 12,
            unique_cards: 10,
            total_sets: 3,
            total_value: 900,
            total_cost: 500,
            pnl: 400,
            recent_additions: [],
        },
    })),
    getSets: vi.fn(() => Promise.resolve({data: []})),
}))

vi.mock('../contexts/SettingsContext', () => ({
    useSettings: () => ({
        t: (key) => ({
            'archive.title': 'Collection Overview',
            'archive.subtitle': 'Everything you’ve chosen to keep, right where it belongs.',
            'archive.cardsFiled': 'cards filed',
            'archive.uniqueCards': 'Unique',
            'archive.setsTracked': 'Sets tracked',
            'archive.loading': 'John John is opening the collection…',
            'archive.recentAdditions': 'Recent additions',
            'archive.viewCollection': 'View collection',
            'archive.setShelf': 'Set shelf',
            'archive.allSets': 'All sets',
            'archive.notesTitle': 'John John’s Notes',
            'archive.keepingWatch': 'John John is keeping watch.',
        })[key] || key,
    }),
}))

vi.mock('../components/reactbits/SplitText', () => ({
    default: ({text}) => <>{text}</>,
}))

// The overview copy used to live in a constant exported from Home.jsx. It is
// now in the i18n layer so the landing surface can be translated, but the
// guard it carried still matters and is asserted against that source instead.
const overview = en.archive

describe('Collection Overview copy', () => {
    it('uses Collection Overview language for the root surface', () => {
        expect(overview.title).toBe('Collection Overview')
        expect(overview.notesTitle).toBe('John John’s Notes')
        expect(overview.keepingWatch).toBe('John John is keeping watch.')
    })

    it('calls the root Collection Overview without market copy', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {queries: {retry: false}},
        })

        render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter>
                    <Home/>
                </MemoryRouter>
            </QueryClientProvider>,
        )

        expect(await screen.findByRole('heading', {name: 'Collection Overview'})).toBeVisible()
        expect(screen.getByRole('heading', {name: 'John John’s Notes'})).toBeVisible()
        expect(screen.getByText('Collection care')).toBeVisible()
        expect(screen.queryByText(/portfolio|P&L|market/i)).not.toBeInTheDocument()
    })

    it('fully disables overview motion when reduced motion is requested', () => {
        const here = dirname(fileURLToPath(import.meta.url))
        const css = readFileSync(resolve(here, '../design/archive.css'), 'utf-8')
        const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

        expect(css).toMatch(/\.archive-card-reveal\s*\{[^}]*animation:/)
        expect(css).toMatch(/\.archive-loading-orbit\s*\{[^}]*animation:/)
        expect(reducedMotion).toMatch(/\.archive-shell \*,[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/)
        expect(reducedMotion).toMatch(/\.archive-card-reveal,[\s\S]*?\.archive-loading-orbit,[\s\S]*?transform: none !important;/)
    })

    it('does not repeat a heading in an eyebrow above it', () => {
        // The kicker/latestKicker pair held the same words as the heading directly
        // beneath, so each section announced its own name twice.
        expect(overview.kicker).toBeUndefined()
        expect(overview.latestKicker).toBeUndefined()
    })

    it('anchors the surface on a count rather than a value', () => {
        // The page had no focal point: a label, a title and a subtitle, then
        // content. The anchor is a card count precisely because the finance rule
        // below rules out the obvious alternative.
        expect(overview.cardsFiled).toBe('cards filed')
        expect(overview.uniqueCards).toBeTruthy()
        expect(overview.setsTracked).toBeTruthy()
        expect(`${overview.cardsFiled} ${overview.uniqueCards} ${overview.setsTracked}`)
            .not.toMatch(/[$€£]|value|price|worth|cost/i)
    })

    it('keeps finance language off the landing surface', () => {
        // The spec makes this an unpriced surface; price belongs in card detail.
        expect(Object.values(overview).join(' ')).not.toMatch(/portfolio|P&L|market|profit/i)
    })

    it('calls the collection by one name', () => {
        // Archive and Databank were competing nouns for the same thing.
        expect(Object.values(overview).join(' ')).not.toMatch(/\barchive\b|\bdatabank\b/i)
    })



    it('keeps John John’s Notes static, local, and non-chatbot', () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './Home.jsx'), 'utf-8')
        expect(source).toContain('LOCAL_COLLECTION_NOTES')
        expect(source).not.toMatch(/getAgentNotes|agent-notes|\/agent\/notes|fetch\s*\(/)
        expect(source).not.toMatch(/Gemini|Obsidian|chatbot/i)
    })


    it('keeps placeholders intact on the interpolated strings', () => {
        expect(overview.lastFiled).toContain('{name}')
        expect(overview.cardsLeft).toContain('{count}')
        expect(overview.filedOfTotal).toContain('{owned}')
        expect(overview.filedOfTotal).toContain('{total}')
    })
})
