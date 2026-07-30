import {act, renderHook} from '@testing-library/react'
import {ARCHIVE_THEME_STORAGE_KEY, useTheme} from './useTheme'

test("keeps John John's PC in dark-only mode", () => {
    localStorage.setItem(ARCHIVE_THEME_STORAGE_KEY, 'light')
    document.documentElement.dataset.theme = 'light'

    const {result} = renderHook(() => useTheme())

    expect(result.current.theme).toBe('midnight')
    expect(result.current.themes).toEqual([{id: 'midnight', label: "John John's PC"}])
    expect(localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)).toBe('midnight')
    expect(document.documentElement.dataset.theme).toBe('midnight')

    act(() => result.current.setTheme('light'))

    expect(localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)).toBe('midnight')
    expect(document.documentElement.dataset.theme).toBe('midnight')
})
