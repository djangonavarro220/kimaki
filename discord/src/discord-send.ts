import type { ThreadChannel } from 'discord.js'

export const DISCORD_MESSAGE_LIMIT = 2000

type Logger = {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

const sendQueues = new Map<string, Promise<unknown>>()

function enqueueSerial<T>({
  key,
  operation,
}: {
  key: string
  operation: () => Promise<T>
}): Promise<T> {
  const previous = sendQueues.get(key) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      return operation()
    })

  sendQueues.set(key, current)

  return current.finally(() => {
    if (sendQueues.get(key) === current) {
      sendQueues.delete(key)
    }
  }) as Promise<T>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sanitizeDiscordContent(content: string): string {
  return content
    .replace(/\u0000/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function enforceMessageLimit(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content
  return content.slice(0, DISCORD_MESSAGE_LIMIT)
}

function getErrorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object') return undefined
  return (error as Record<string, unknown>)[key]
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message
  }
  return String(error)
}

function isInvalidFormBodyError(error: unknown): boolean {
  const code = asNumber(getErrorField(error, 'code'))
  if (code === 50035) return true

  const name = String(getErrorField(error, 'name') ?? '')
  const message = String(getErrorField(error, 'message') ?? '')
  return (
    name.includes('DiscordAPIError') && message.includes('Invalid Form Body')
  )
}

function isTransientSendError(error: unknown): boolean {
  const status = asNumber(getErrorField(error, 'status'))
  if (status && (status === 429 || (status >= 500 && status <= 599))) {
    return true
  }

  const code = String(getErrorField(error, 'code') ?? '')
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
}

export type SafeDiscordSendResult<T> = {
  firstMessage: T | null
  sentCount: number
  droppedCount: number
  unsentContent: string
}

async function sendChunkWithRetry<T>({
  send,
  rawChunk,
  logger,
  context,
  maxAttempts,
}: {
  send: (content: string) => Promise<T>
  rawChunk: string
  logger: Logger
  context: string
  maxAttempts: number
}): Promise<
  { kind: 'sent'; message: T } | { kind: 'dropped' } | { kind: 'retry_later' }
> {
  let chunk = enforceMessageLimit(sanitizeDiscordContent(rawChunk))
  if (!chunk.trim()) {
    return { kind: 'dropped' }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const message = await send(chunk)
      return { kind: 'sent', message }
    } catch (error) {
      if (isInvalidFormBodyError(error)) {
        const fixed = enforceMessageLimit(sanitizeDiscordContent(chunk))
        if (!fixed.trim()) {
          logger.warn(`${context}: dropped empty/invalid chunk after sanitize`)
          return { kind: 'dropped' }
        }

        if (fixed !== chunk) {
          chunk = fixed
          continue
        }

        logger.error(
          `${context}: Invalid Form Body, dropping chunk`,
          errorSummary(error),
        )
        return { kind: 'dropped' }
      }

      if (isTransientSendError(error)) {
        if (attempt >= maxAttempts) {
          logger.warn(
            `${context}: transient send failure, will retry later`,
            errorSummary(error),
          )
          return { kind: 'retry_later' }
        }

        const base = 300 * 2 ** (attempt - 1)
        const jitter = Math.floor(Math.random() * 150)
        await sleep(base + jitter)
        continue
      }

      logger.error(
        `${context}: send failed, dropping chunk`,
        errorSummary(error),
      )
      return { kind: 'dropped' }
    }
  }

  return { kind: 'retry_later' }
}

export async function safeSendDiscordText<T>({
  channelId,
  content,
  send,
  split,
  logger,
  context,
  maxAttempts = 3,
}: {
  channelId: string
  content: string
  send: (content: string) => Promise<T>
  split: (content: string) => string[]
  logger: Logger
  context: string
  maxAttempts?: number
}): Promise<SafeDiscordSendResult<T>> {
  return enqueueSerial({
    key: channelId,
    operation: async () => {
      const sanitized = sanitizeDiscordContent(content)
      if (!sanitized.trim()) {
        return {
          firstMessage: null,
          sentCount: 0,
          droppedCount: 0,
          unsentContent: '',
        }
      }

      const chunks = split(sanitized)
        .map((c) => {
          return enforceMessageLimit(sanitizeDiscordContent(c))
        })
        .filter((c) => {
          return c.trim().length > 0
        })

      let firstMessage: T | null = null
      let sentCount = 0
      let droppedCount = 0
      const unsentChunks: string[] = []

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!
        const result = await sendChunkWithRetry({
          send,
          rawChunk: chunk,
          logger,
          context: `${context} (chunk ${i + 1}/${chunks.length})`,
          maxAttempts,
        })

        if (result.kind === 'sent') {
          if (!firstMessage) {
            firstMessage = result.message
          }
          sentCount++
          continue
        }

        if (result.kind === 'dropped') {
          droppedCount++
          continue
        }

        unsentChunks.push(...chunks.slice(i))
        break
      }

      return {
        firstMessage,
        sentCount,
        droppedCount,
        unsentContent: unsentChunks.join('\n'),
      }
    },
  })
}

export function getDiscordSendKey(channel: ThreadChannel): string {
  return channel.id
}
