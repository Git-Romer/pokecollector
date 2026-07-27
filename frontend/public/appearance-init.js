/* Apply persisted appearance before styles and React paint. Keep dependency-free. */
(() => {
  const modes = ['system', 'light', 'dark']
  const accents = ['default', 'fire', 'water', 'grass', 'electric', 'psychic', 'dragon', 'dark', 'fairy']
  let mode = 'system'
  let accent = 'default'

  try {
    const storedMode = localStorage.getItem('pokecollector-color-mode')
    mode = modes.includes(storedMode) ? storedMode : 'system'
    const storedAccent = localStorage.getItem('pokecollector-accent')
    const legacyAccent = localStorage.getItem('theme')
    accent = accents.includes(storedAccent)
      ? storedAccent
      : (accents.includes(legacyAccent) ? legacyAccent : 'default')
    localStorage.setItem('pokecollector-accent', accent)
  } catch (_) {
    // Storage can be disabled; system/default still provides a safe appearance.
  }

  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode
  const root = document.documentElement
  root.dataset.colorMode = resolved
  root.dataset.accent = accent
  root.dataset.theme = accent
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
})()
