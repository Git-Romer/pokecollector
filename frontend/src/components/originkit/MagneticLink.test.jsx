import {render, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {describe, expect, it, vi} from 'vitest'
import MagneticLink from './MagneticLink'


function renderLink() {
    return render(
        <MemoryRouter>
            <MagneticLink to="/collection">View collection</MagneticLink>
        </MemoryRouter>,
    )
}

describe('MagneticLink', () => {

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

    it('uses the single John John motion path', () => {
        window.matchMedia = vi.fn(() => {
            throw new Error('matchMedia should not be read by this component')
        })

        renderLink()

        expect(screen.getByRole('link', {name: 'View collection'})).toBeVisible()
        expect(window.matchMedia).not.toHaveBeenCalled()
    })
})
