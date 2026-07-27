import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react'

export const COLOR_MODES = ['system', 'light', 'dark']
export const ACCENTS = [
  { id: 'default', labelKey: 'accentDefault', color: '#e3000b', emoji: '🔴' },
  { id: 'fire', labelKey: 'accentFire', color: '#ff6b35', emoji: '🔥' },
  { id: 'water', labelKey: 'accentWater', color: '#1684c5', emoji: '💧' },
  { id: 'grass', labelKey: 'accentGrass', color: '#43a047', emoji: '🌿' },
  { id: 'electric', labelKey: 'accentElectric', color: '#fdd835', emoji: '⚡' },
  { id: 'psychic', labelKey: 'accentPsychic', color: '#ab47bc', emoji: '🔮' },
  { id: 'dragon', labelKey: 'accentDragon', color: '#7e57c2', emoji: '🐉' },
  { id: 'dark', labelKey: 'accentDark', color: '#607d8b', emoji: '🌑' },
  { id: 'fairy', labelKey: 'accentFairy', color: '#ec407a', emoji: '🧚' },
]

const MODE_KEY = 'pokecollector-color-mode'
const ACCENT_KEY = 'pokecollector-accent'
const validAccent = (value) => ACCENTS.some(({ id }) => id === value)
const read = (key) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key, value) => { try { localStorage.setItem(key, value) } catch { /* Preferences remain usable in-memory. */ } }
const resolveMode = (mode) => mode === 'system'
  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : mode

export function applyAppearance(mode, accent) {
  const resolved = resolveMode(mode)
  const root = document.documentElement
  root.dataset.colorMode = resolved
  root.dataset.accent = accent
  root.dataset.theme = accent // Temporary compatibility for third-party/custom styles.
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  return resolved
}

export function initializeAppearance() {
  const savedMode = read(MODE_KEY)
  const colorMode = COLOR_MODES.includes(savedMode) ? savedMode : 'system'
  const savedAccent = read(ACCENT_KEY)
  const legacyAccent = read('theme')
  const accent = validAccent(savedAccent)
    ? savedAccent
    : (validAccent(legacyAccent) ? legacyAccent : 'default')

  // Keep migration and validation available if the early bootstrap is unavailable.
  write(MODE_KEY, colorMode)
  write(ACCENT_KEY, accent)
  return { colorMode, accent, resolvedColorMode: applyAppearance(colorMode, accent) }
}

const AppearanceContext = createContext(null)

function useAppearanceState() {
  const [colorMode, setColorModeState] = useState(() => {
    const saved = read(MODE_KEY)
    return COLOR_MODES.includes(saved) ? saved : 'system'
  })
  const [accent, setAccentState] = useState(() => {
    const saved = read(ACCENT_KEY)
    if (validAccent(saved)) return saved
    const legacy = read('theme')
    return validAccent(legacy) ? legacy : 'default'
  })
  const [resolvedColorMode, setResolvedColorMode] = useState(() => resolveMode(colorMode))

  useEffect(() => {
    write(MODE_KEY, colorMode)
    write(ACCENT_KEY, accent)
    setResolvedColorMode(applyAppearance(colorMode, accent))

    if (colorMode !== 'system') return undefined
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setResolvedColorMode(applyAppearance('system', accent))
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [colorMode, accent])

  const setColorMode = useCallback((value) => {
    if (COLOR_MODES.includes(value)) setColorModeState(value)
  }, [])
  const setAccent = useCallback((value) => {
    if (validAccent(value)) setAccentState(value)
  }, [])

  return { colorMode, resolvedColorMode, setColorMode, accent, setAccent, colorModes: COLOR_MODES, accents: ACCENTS }
}

export function AppearanceProvider({ children }) {
  const appearance = useAppearanceState()
  return createElement(AppearanceContext.Provider, { value: appearance }, children)
}

export function useAppearance() {
  const appearance = useContext(AppearanceContext)
  if (!appearance) throw new Error('useAppearance must be used within AppearanceProvider')
  return appearance
}

// Keep the old export name while exposing the independent appearance API.
export const useTheme = useAppearance
