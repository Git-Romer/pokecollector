import {render, screen} from '@testing-library/react'
import {describe, expect, test} from 'vitest'

import ImportReviewNotice from './ImportReviewNotice'

describe('ImportReviewNotice', () => {
    test('states that imported data is reviewed before existing items change', () => {
        render(<ImportReviewNotice/>)

        expect(
            screen.getByText(/review imported records before changing existing collection items/i),
        ).toBeVisible()
    })
})
