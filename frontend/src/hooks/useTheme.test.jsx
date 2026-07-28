import {act, renderHook} from '@testing-library/react'
import {ARCHIVE_THEME_STORAGE_KEY, useTheme} from './useTheme'

test('persists the selected archive theme and applies it to the document root', () => {
    const {result} = renderHook(() => useTheme())

    act(() => result.current.setTheme('light'))

    expect(localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
})
