import {render, screen} from '@testing-library/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {beforeEach, describe, expect, test, vi} from 'vitest'

import ExcelImportModal from './ExcelImportModal'
import ImportReviewNotice from './ImportReviewNotice'

vi.mock('../contexts/SettingsContext', () => ({
    useSettings: () => ({t: key => key}),
}))

beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })
})

describe('ImportReviewNotice', () => {
    test('uses the DaisyUI informational alert treatment', () => {
        render(<ImportReviewNotice/>)

        expect(screen.getByRole('note')).toHaveClass('daisy-alert', 'daisy-alert-info')
    })

    test('is visible when the import modal opens', () => {
        const queryClient = new QueryClient({
            defaultOptions: {queries: {retry: false}, mutations: {retry: false}},
        })
        render(
            <QueryClientProvider client={queryClient}>
                <ExcelImportModal isOpen onClose={() => {
                }}/>
            </QueryClientProvider>,
        )

        expect(screen.getByRole('dialog', {name: 'Review Excel workbook'})).toBeVisible()
        expect(
            screen.getByText(/review imported records before changing existing collection items/i),
        ).toBeVisible()
    })
})
