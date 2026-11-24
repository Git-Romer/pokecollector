import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import App from './App.jsx'
import { readPwaFlags } from './pwa/flags'
import { handlePreloadError, initServiceWorker } from './pwa/register'
import { updateStore } from './pwa/updateStore'
import './components/card-system/tokens.css'
import './index.css'
import './components/card-system/styles.css'

// Apply saved theme before first paint to prevent flash
const savedTheme = localStorage.getItem('theme')
if (savedTheme && savedTheme !== 'default') {
  document.documentElement.setAttribute('data-theme', savedTheme)
}

// index.html loads Google Fonts with media="print" so it never blocks the first paint;
// switch it on once it has loaded. Offline it never loads and the system font is used.
const fontSheet = document.querySelector('link[data-pc-fonts]')
if (fontSheet) {
  if (fontSheet.sheet) fontSheet.media = 'all'
  else fontSheet.addEventListener('load', () => { fontSheet.media = 'all' }, { once: true })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
    },
  },
})

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: '#1a1a2e',
            color: '#fff',
            border: '1px solid #2a2a4a',
          },
          success: {
            iconTheme: { primary: '#10b981', secondary: '#fff' },
          },
          error: {
            iconTheme: { primary: '#EE1515', secondary: '#fff' },
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
)

// Opt-in service worker (PWA_ENABLED). Never activates a new worker without the user's click.
initServiceWorker({ flags: readPwaFlags(), onUpdateReady: registration => updateStore.setReady(registration) })

// A lazy chunk that fails to load after a deploy: offer the update, or reload once.
window.addEventListener('vite:preloadError', event => {
  const { registration } = updateStore.getSnapshot()
  handlePreloadError(event, { onUpdateReady: registration ? () => updateStore.setReady(registration) : null, registration })
})
