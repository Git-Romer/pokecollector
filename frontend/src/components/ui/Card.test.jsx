import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import Card from './Card'

describe('Card', () => {
    it('activates on both Enter and Space when clickable', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(<Card onClick={onClick}>contents</Card>)

        const card = screen.getByRole('button')
        card.focus()

        await user.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledTimes(1)

        await user.keyboard(' ')
        expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('leaves a space typed in nested content to that control', async () => {
        const user = userEvent.setup()
        const onClick = vi.fn()
        render(
            <Card onClick={onClick}>
                <input aria-label="search"/>
            </Card>
        )

        // Focused directly: a click would bubble to the card by ordinary event
        // propagation, which is separate from the keyboard behaviour under test.
        const field = screen.getByLabelText('search')
        field.focus()
        await user.keyboard('pika chu')

        expect(field).toHaveValue('pika chu')
        expect(onClick).not.toHaveBeenCalled()
    })

    it('exposes no button semantics when not clickable', () => {
        render(<Card>contents</Card>)
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })
})
