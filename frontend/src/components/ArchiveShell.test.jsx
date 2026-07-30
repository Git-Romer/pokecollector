import {render, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {vi} from 'vitest'
import {PRIMARY_ARCHIVE_DESTINATIONS} from './archiveNavigation'
import ArchiveShell from './ArchiveShell'

vi.mock('../contexts/SettingsContext', () => ({
    useSettings: () => ({
        t: (key) => ({
            'archive.primaryNav': 'Main',
            'archive.search': 'Search your collection',
        })[key] || key,
    }),
}))

vi.mock('./ArchiveCommandBar', () => ({default: () => null}))
vi.mock('./JohnJohnSignal', () => ({default: () => <span aria-hidden="true">∞</span>}))
vi.mock('./reactbits/ShinyText', () => ({default: ({text}) => <span>{text}</span>}))

test('keeps the five primary destinations', () => {
    // Sets → All Cards and Analytics → Trends & Insights were renamed for
    // clarity; the routes /sets and /analytics still redirect to the new
    // paths, so old links keep working. The count of five is the contract.
    expect(PRIMARY_ARCHIVE_DESTINATIONS.map(({label, to}) => [label, to])).toEqual([
        ['Collection', '/collection'],
        ['Card Search', '/search'],
        ['All Cards', '/all-cards'],
        ['Trends & Insights', '/trends'],
        ['Settings', '/settings'],
    ])
})


test('wordmark returns to the root collection entry route', () => {
    render(
        <MemoryRouter>
            <ArchiveShell/>
        </MemoryRouter>,
    )

    const wordmark = screen.getByRole('link', {name: "John John's PC, Collection Overview"})
    expect(wordmark).toHaveAttribute('href', '/')
    expect(screen.getAllByText("John John's PC")[0]).toBeVisible()
    PRIMARY_ARCHIVE_DESTINATIONS.forEach(({label, to}) => {
        expect(screen.getByRole('link', {name: label})).toHaveAttribute('href', to)
    })
})
