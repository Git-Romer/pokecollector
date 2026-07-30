import {render, screen} from '@testing-library/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {describe, expect, test, vi} from 'vitest'
import Settings from './Settings'

vi.mock('../api/client', () => {
    const noop = vi.fn()
    return {
        default: {delete: noop},
        changeAvatar: noop,
        changePassword: noop,
        changeUsername: noop,
        createUser: noop,
        deleteUser: noop,
        downloadBackup: noop,
        downloadDebugLog: noop,
        exportCSV: noop,
        exportXLSX: noop,
        getContributors: vi.fn(() => Promise.resolve([])),
        getRescueDonations: vi.fn(() => Promise.resolve({total_amount: 0, currency: 'USD'})),
        getSetting: vi.fn(() => Promise.resolve({value: ''})),
        getSupporters: vi.fn(() => Promise.resolve([])),
        getSyncStatus: vi.fn(() => Promise.resolve({data: {}})),
        getTelegramStatus: vi.fn(() => Promise.resolve({configured: false})),
        getUsers: vi.fn(() => Promise.resolve([])),
        rescheduleFullSync: noop,
        reschedulePriceSync: noop,
        restoreBackup: noop,
        setAuthMode: noop,
        setSetting: noop,
        triggerAllPriceSync: noop,
        triggerSync: noop,
        updateUser: noop,
    }
})

vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({
        user: {id: 1, username: 'John', role: 'trainer', avatar_id: null},
        updateCurrentUser: vi.fn(),
        multiUser: false,
    }),
}))

vi.mock('../contexts/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            language: 'en',
            currency: 'USD',
            price_primary: 'trend',
            tcgdex_sync_languages: 'en',
        },
        updateSettings: vi.fn(),
        pricePrimaryField: 'price_trend',
        exchangeRate: 1,
        t: (key) => ({
            'settings.title': 'Settings',
            'settings.appConfig': 'App configuration',
            'settings.tabs.general': 'General',
            'settings.tabs.notifications': 'Notifications',
            'settings.privacyDataTitle': 'Privacy & Data',
            'settings.privacyDataDesc': 'Your local-first data boundary.',
        })[key] ?? key,
    }),
}))

vi.mock('../components/reactbits/SplitText', () => ({
    default: ({text}) => <>{text}</>,
}))

vi.mock('../components/AvatarPicker', () => ({
    default: () => null,
}))

describe('Settings privacy behavior', () => {
    test('explains the local Privacy & Data boundary', () => {
        const queryClient = new QueryClient({
            defaultOptions: {queries: {retry: false}},
        })

        render(
            <QueryClientProvider client={queryClient}>
                <Settings/>
            </QueryClientProvider>,
        )

        expect(screen.getByRole('heading', {name: 'Privacy & Data'})).toBeVisible()
        expect(screen.getByText(/external AI is disabled by default/i)).toBeVisible()
        expect(screen.getByText(/imports are reviewed manually/i)).toBeVisible()
        expect(screen.getByText(/Excel export is local and portable/i)).toBeVisible()
    })
})
