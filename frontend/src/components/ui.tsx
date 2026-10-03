// Small shared building blocks on Radix primitives (tech-stack 4.3, plan D8).
import { AlertTriangle, Check, Circle, Loader, MoreHorizontal, X } from 'lucide-react'
import { AlertDialog, DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { ApiRequestError, type ImportStatus } from '../api/client'
import { STATUS_LABELS } from '../admin/format'

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  const message =
    error instanceof ApiRequestError
      ? (error.body?.message ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error)
  return (
    <p role="alert" className="text-danger my-2 text-sm">
      {message}
    </p>
  )
}

export function Loading() {
  return (
    <p className="text-muted flex items-center gap-2 text-sm">
      <Loader size={14} className="animate-spin" aria-hidden /> Lädt …
    </p>
  )
}

const STATUS_ICONS: Record<ImportStatus, ReactNode> = {
  ok: <Check size={14} aria-hidden />,
  warning: <AlertTriangle size={14} aria-hidden />,
  failed: <X size={14} aria-hidden />,
  aborted: <Circle size={12} aria-hidden />,
  running: <Loader size={14} aria-hidden />,
}

export function StatusBadge({ status }: { status: ImportStatus }) {
  const tone =
    status === 'warning'
      ? 'chip chip-active'
      : status === 'failed'
        ? 'chip border-danger text-danger'
        : 'chip'
  return (
    <span className={tone}>
      {STATUS_ICONS[status]}
      {STATUS_LABELS[status]}
    </span>
  )
}

/** Four-step indicator ●●●○ (design D2). */
export function Dots({ value, max = 4, label }: { value: number; max?: number; label: string }) {
  return (
    <span role="img" aria-label={`${label}: ${value} von ${max}`} className="inline-flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`inline-block size-2.5 rounded-full border ${
            i < value ? 'bg-ink border-ink' : 'border-neutral-500'
          }`}
        />
      ))}
    </span>
  )
}

export function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="btn border-transparent px-1" aria-label={label}>
        <MoreHorizontal size={16} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="card bg-neutral-100 z-50 min-w-40 py-1 shadow-[var(--shadow-md)]"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function MenuItem({
  onSelect,
  children,
  danger,
}: {
  onSelect: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`cursor-pointer px-3 py-1 text-sm outline-none data-[highlighted]:bg-neutral-200 ${
        danger ? 'text-danger' : ''
      }`}
    >
      {children}
    </DropdownMenu.Item>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  onConfirm,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  confirm: string
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="bg-ink/30 fixed inset-0 z-40" />
        <AlertDialog.Content className="card fixed top-1/3 left-1/2 z-50 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5 shadow-[var(--shadow-md)]">
          <AlertDialog.Title className="mb-2 text-xl">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="text-sm">{children}</div>
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn">Abbrechen</AlertDialog.Cancel>
            <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
              {confirm}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
