import {fireEvent, render, screen} from '@testing-library/react'
import {expect, test, vi} from 'vitest'

import CardListItem from './CardListItem'

test('clickable card list items support Enter and Space activation', () => {
    const onClick = vi.fn()
    render(<CardListItem name="Latias ex" subtext="Surging Sparks" onClick={onClick}/>)

    const row = screen.getByRole('button', {name: /Latias ex/i})
    fireEvent.keyDown(row, {key: 'Enter'})
    fireEvent.keyDown(row, {key: ' '})

    expect(onClick).toHaveBeenCalledTimes(2)
})
