const THREAD_TITLE_MAX = 100
const DEFAULT_SESSION_TITLE = 'Untitled Session'
const PENDING_RENAME_TTL_MS = 10000

type PendingRename = {
  title: string
  at: number
}

const pendingThreadRenames = new Map<string, PendingRename>()

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

export function truncateTitle(title: string, maxLength = THREAD_TITLE_MAX): string {
  if (title.length <= maxLength) return title
  const sliceLength = Math.max(0, maxLength - 1)
  return title.slice(0, sliceLength) + '…'
}

export function buildThreadTitle(sessionTitle?: string | null, maxLength = THREAD_TITLE_MAX): string {
  const normalized = normalizeTitle(sessionTitle || '')
  if (!normalized) return DEFAULT_SESSION_TITLE
  return truncateTitle(normalized, maxLength)
}

export function markThreadRename(threadId: string, title: string): void {
  pendingThreadRenames.set(threadId, { title, at: Date.now() })
}

export function consumePendingThreadRename(threadId: string, title: string): boolean {
  const entry = pendingThreadRenames.get(threadId)
  if (!entry) return false

  if (Date.now() - entry.at > PENDING_RENAME_TTL_MS) {
    pendingThreadRenames.delete(threadId)
    return false
  }

  if (normalizeTitle(entry.title) !== normalizeTitle(title)) {
    return false
  }

  pendingThreadRenames.delete(threadId)
  return true
}
