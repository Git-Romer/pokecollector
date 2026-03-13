import { useState, useEffect, useCallback } from 'react'

const THEMES = [
  { id: 'default', label: 'Pokémon Red', color: '#e3000b', emoji: '🔴' },
  { id: 'fire', label: 'Fire', color: '#ff6b35', emoji: '🔥' },
  { id: 'water', label: 'Water', color: '#4fc3f7', emoji: '💧' },
  { id: 'grass', label: 'Grass', color: '#66bb6a', emoji: '🌿' },
  { id: 'electric', label: 'Electric', color: '#fdd835', emoji: '⚡' },
  { id: 'psychic', label: 'Psychic', color: '#ce93d8', emoji: '🔮' },
  { id: 'dragon', label: 'Dragon', color: '#9575cd', emoji: '🐉' },
  { id: 'dark', label: 'Dark', color: '#78909c', emoji: '🌑' },
  { id: 'fairy', label: 'Fairy', color: '#f48fb1', emoji: '🧚' },
]

export function useTheme() {
  const [theme, setThemeState] = useState(() => localStorage.getItem('theme') || 'default')

  useEffect(() => {
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
    localStorage.setItem('theme', theme)
  }, [theme])

  const setTheme = useCallback((t) => setThemeState(t), [])

  return { theme, setTheme, themes: THEMES }
}
