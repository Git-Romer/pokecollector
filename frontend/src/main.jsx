import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { FluentProvider } from '@fluentui/react-components'
import App from './App.jsx'
import './index.css'
import './design/archive.css'
import { archiveDarkTheme, archiveLightTheme } from './design/archiveTheme'
import { ARCHIVE_THEME_STORAGE_KEY, useTheme } from './hooks/useTheme'

// Apply saved theme before first paint to prevent flash
const savedTheme = localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)
document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'midnight'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
    },
  },
})

function ThemedApp() {
  const { theme } = useTheme()

  return (
    <FluentProvider theme={theme === 'light' ? archiveLightTheme : archiveDarkTheme}>
      <App />
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: theme === 'light' ? '#ffffff' : '#101c30',
            color: theme === 'light' ? '#172033' : '#f4f7ff',
            border: '1px solid #293b59',
          },
          success: {
            iconTheme: { primary: '#10b981', secondary: '#fff' },
          },
          error: {
            iconTheme: { primary: '#EE1515', secondary: '#fff' },
          },
        }}
      />
    </FluentProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemedApp />
    </QueryClientProvider>
  </React.StrictMode>
)
