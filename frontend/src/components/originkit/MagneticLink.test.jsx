import {render, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import MagneticLink from './MagneticLink'

function setReducedMotion(reduced) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: reduced && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }))
}

function renderLink() {
    return render(
        <MemoryRouter>
            <MagneticLink to="/collection">View collection</MagneticLink>
        </MemoryRouter>,
    )
}

describe('MagneticLink', () => {
    beforeEach(() => setReducedMotion(false))

    it('routes rather than navigating away', () => {
        // The Originkit original renders a bare <a href>, which inside a router is
        // a full page reload. This is the primary call to action on the page.
        renderLink()

        expect(screen.getByRole('link', {name: 'View collection'})).toHaveAttribute(
            'href',
            '/collection',
        )
    })

    it('keeps the decorative sweep out of the accessible name', () => {
        const {container} = renderLink()

        expect(container.querySelector('.magnetic-link-sweep')).toHaveAttribute(
            'aria-hidden',
            'true',
        )
        expect(screen.getByRole('link').textContent).toBe('View collection')
    })

    it('keeps the caller class alongside its own', () => {
        render(
            <MemoryRouter>
                <MagneticLink to="/collection" className="archive-featured-action">
                    View collection
                </MagneticLink>
            </MemoryRouter>,
        )

        const link = screen.getByRole('link')
        expect(link).toHaveClass('magnetic-link')
        expect(link).toHaveClass('archive-featured-action')
    })

    it('does not follow the pointer when reduced motion is requested', () => {
        // The global reduced-motion rule collapses CSS durations but cannot stop a
        // transform written from JavaScript, so this has to be handled explicitly.
        setReducedMotion(true)
        const {container} = renderLink()

        window.dispatchEvent(new MouseEvent('pointermove', {clientX: 10, clientY: 10}))

        const link = container.querySelector('.magnetic-link')
        expect(link.style.getPropertyValue('--magnet-x')).toBe('')
        expect(link.style.getPropertyValue('--magnet-y')).toBe('')
    })
})
