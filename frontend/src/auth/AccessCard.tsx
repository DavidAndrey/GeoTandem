// Frame of the pages before the application: setup, sign-in, mandatory password.
import type { ReactNode } from 'react'

export function AccessCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-[12vh]">
      <section aria-labelledby="access-title" className="card w-full max-w-sm p-6">
        <p className="font-heading text-muted mb-1 text-lg">GeoTandem</p>
        <h1 id="access-title" className="mb-4 text-3xl">
          {title}
        </h1>
        {children}
      </section>
    </main>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 flex flex-col gap-1">
      <span className="label-caps">{label}</span>
      {children}
    </label>
  )
}
