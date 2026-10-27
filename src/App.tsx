import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Header } from '@/components/Header'
import { HomePage } from '@/pages/HomePage'
import { PotPage } from '@/pages/PotPage'
import { MyPotsPage } from '@/pages/MyPotsPage'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-dvh flex flex-col" style={{ background: 'var(--bg-gradient)' }}>
        <Header />
        <Routes>
          <Route path="/"                          element={<HomePage />} />
          <Route path="/p/:chainId/:potId"         element={<PotPage />} />
          <Route path="/my"                        element={<MyPotsPage />} />
          <Route path="*" element={
            <main className="flex-1 flex items-center justify-center text-[var(--muted)]">
              Page not found.
            </main>
          } />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
