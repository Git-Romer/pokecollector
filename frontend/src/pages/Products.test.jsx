import {render, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {vi} from 'vitest'
import Collection from './Collection'

vi.mock('@tanstack/react-query', async (importOriginal) => {
    const actual = await importOriginal()
    return {
        ...actual,
        useMutation: () => ({mutate: vi.fn(), isPending: false}),
        useQueryClient: () => ({
            invalidateQueries: vi.fn(),
            setQueryData: vi.fn(),
        }),
        useQuery: ({queryKey}) => ({
            data: queryKey[0] === 'collection' ? [] : [],
            isLoading: false,
            error: null,
        }),
    }
})

vi.mock('../contexts/SettingsContext', () => ({
    useSettings: () => ({
        t: (key) => ({
            'nav.collection': 'Collection',
            'nav.binders': 'Binders',
            'nav.wishlist': 'Wishlist',
            'collection.cards': 'cards',
        })[key] || key,
        formatPrice: (value) => `$${Number(value || 0).toFixed(2)}`,
        pricePrimaryField: 'price_market',
        currency: 'USD',
        exchangeRate: 1,
        exchangeRateReady: true,
    }),
}))

vi.mock('../hooks/useVisibleTcgdexLanguages', () => ({
    useVisibleTcgdexLanguages: () => [],
}))

vi.mock('../components/reactbits/SplitText', () => ({
    default: ({text}) => <>{text}</>,
}))

test('offers sealed product from Collection without a new primary nav item', () => {
    window.matchMedia = vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }))
    render(<Collection/>, {wrapper: MemoryRouter})
    expect(screen.getByRole('link', {name: 'Sealed product'})).toHaveAttribute('href', '/products')
})
