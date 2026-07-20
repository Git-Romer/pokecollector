import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Modal, { DESKTOP_MODAL_QUERY } from './Modal'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: (key) => key }),
}))

/** jsdom has no layout engine, so matchMedia and offsetParent are stubbed. */
function setViewport(isDesktop) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query === DESKTOP_MODAL_QUERY ? isDesktop : !isDesktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  setViewport(true)
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.parentNode },
  })
})

describe('Modal', () => {
  it('renders exactly one dialog per viewport', () => {
    setViewport(true)
    const { unmount } = render(
      <Modal isOpen onClose={() => {}} title="Card detail"><p>body</p></Modal>
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    unmount()

    setViewport(false)
    render(<Modal isOpen onClose={() => {}} title="Card detail"><p>body</p></Modal>)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('names the dialog with its own title', () => {
    render(<Modal isOpen onClose={() => {}} title="Card detail"><p>body</p></Modal>)
    expect(screen.getByRole('dialog', { name: 'Card detail' })).toBeInTheDocument()
  })

  it('moves focus into the dialog and restores it on close', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          <Modal isOpen={open} onClose={() => setOpen(false)} title="Card detail">
            <button>inside</button>
          </Modal>
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'open' })

    opener.focus()
    await user.click(opener)
    expect(document.activeElement).not.toBe(opener)
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(
      <Modal isOpen onClose={() => {}} title="Card detail">
        <button>one</button>
        <button>two</button>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')

    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement)
    }
  })
})
