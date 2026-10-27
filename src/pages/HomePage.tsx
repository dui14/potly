import { CreatePotForm } from '@/components/CreatePotForm'
import { ProofStrip } from '@/components/ProofStrip'

export function HomePage() {
  return (
    <main className="max-w-lg mx-auto px-4 py-8 flex flex-col gap-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-[var(--ink)] tracking-tight">Create a pot</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Everyone deposits an equal share. The recipient collects when all slots are filled.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <CreatePotForm />
      </div>

      <ProofStrip />
    </main>
  )
}
