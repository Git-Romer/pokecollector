import {useCallback, useEffect, useState} from 'react'

export const ARCHIVE_THEME_STORAGE_KEY = 'john-johns-pc-theme'
export const ARCHIVE_THEMES = [
    {id: 'midnight', label: "John John's PC"},
]

function readTheme() {
    return 'midnight'
}

export function useTheme() {
    const [theme] = useState(readTheme)

    useEffect(() => {
        document.documentElement.dataset.theme = 'midnight'
        localStorage.setItem(ARCHIVE_THEME_STORAGE_KEY, 'midnight')
    }, [])

    const setTheme = useCallback(() => {
        document.documentElement.dataset.theme = 'midnight'
        localStorage.setItem(ARCHIVE_THEME_STORAGE_KEY, 'midnight')
    }, [])

    return {theme, setTheme, themes: ARCHIVE_THEMES}
}
