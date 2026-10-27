import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { Toaster } from 'sonner'
import { config } from '@/config/wagmi'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          customTheme={{
            '--ck-font-family': "'DM Sans', sans-serif",
            '--ck-primary-button-background': '#122d45',
            '--ck-primary-button-hover-background': '#1061a6',
            '--ck-body-background': '#0d1b2f',
            '--ck-body-color': '#f9faf3',
          }}
        >
          <App />
          <Toaster position="bottom-center" richColors />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
