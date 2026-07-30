import React from 'react'
import ReactDOM from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {Toaster} from 'react-hot-toast'
import {FluentProvider} from '@fluentui/react-components'
import App from './App.jsx'
import './index.css'
import './design/archive.css'
import {archiveDarkTheme} from './design/archiveTheme'
document.documentElement.dataset.theme = 'midnight'

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
    return (
        <FluentProvider theme={archiveDarkTheme}>
            <App/>
            <Toaster
                position="top-center"
                toastOptions={{
                    style: {
                        background: '#101c30',
                        color: '#f4f7ff',
                        border: '1px solid #293b59',
                    },
                    success: {
                        iconTheme: {primary: '#10b981', secondary: '#fff'},
                    },
                    error: {
                        iconTheme: {primary: '#EE1515', secondary: '#fff'},
                    },
                }}
            />
        </FluentProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemedApp/>
        </QueryClientProvider>
    </React.StrictMode>
)
