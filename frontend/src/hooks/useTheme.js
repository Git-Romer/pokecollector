import {useCallback, useEffect, useState} from 'react'

export const ARCHIVE_THEME_STORAGE_KEY = 'john-johns-pc-theme'
export const ARCHIVE_THEMES = [
    {id: 'midnight', label: 'Midnight Archive'},
    {id: 'light', label: 'Daylight Archive'},
]

const themeIds = new Set(ARCHIVE_THEMES.map(({id}) => id))

function readTheme() {
    const savedTheme = localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)
    return themeIds.has(savedTheme) ? savedTheme : 'midnight'
}

export function useTheme() {
    const [theme, setThemeState] = useState(readTheme)

    useEffect(() => {
        document.documentElement.dataset.theme = theme
        localStorage.setItem(ARCHIVE_THEME_STORAGE_KEY, theme)
    }, [theme])

    const setTheme = useCallback((nextTheme) => {
        if (themeIds.has(nextTheme)) setThemeState(nextTheme)
    }, [])

    return {theme, setTheme, themes: ARCHIVE_THEMES}
}
