import type { ThreadChannel } from 'discord.js'
import { splitDiscordMessage } from './chunking.js'
import { safeSendDiscordText } from './discord-send.js'
import { createLogger } from './logger.js'

const shadowLogger = createLogger('SHADOW')

export class ShadowStreamRouter {
  private thread: ThreadChannel
  private buffer: string = ''
  private lastFlush: number = Date.now()
  private FLUSH_INTERVAL = 2000 // 2 seconds
  private isFlushing = false

  constructor(thread: ThreadChannel) {
    this.thread = thread
  }

  /**
   * Append formatted text to the shadow log buffer.
   * Automatically flushes if buffer is full or time interval passed.
   */
  append(text: string) {
    if (!text) return
    this.buffer += text + '\n'
    this.tryFlush().catch((err) => {
      shadowLogger.error('Error in auto-flush:', err)
    })
  }

  /**
   * Send a complete component as its own message (no streaming).
   */
  async sendComponent(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    await this.flush()

    const result = await safeSendDiscordText({
      channelId: this.thread.id,
      content: trimmed,
      send: async (content) => {
        return this.thread.send(content)
      },
      split: splitDiscordMessage,
      logger: shadowLogger,
      context: `ShadowStreamRouter.sendComponent thread=${this.thread.id}`,
      maxAttempts: 3,
    })

    if (result.unsentContent) {
      this.buffer = result.unsentContent + '\n' + this.buffer
    }
  }

  private async tryFlush() {
    if (this.isFlushing) return

    const now = Date.now()
    // Flush if > 1800 chars OR (> 0 chars AND time interval passed)
    if (
      this.buffer.length > 1800 ||
      (this.buffer.length > 0 && now - this.lastFlush > this.FLUSH_INTERVAL)
    ) {
      await this.flush()
    }
  }

  /**
   * Force flush the buffer to Discord.
   */
  async flush() {
    if (!this.buffer.trim() || this.isFlushing) return

    this.isFlushing = true
    const toSend = this.buffer
    this.buffer = ''
    this.lastFlush = Date.now()

    try {
      const result = await safeSendDiscordText({
        channelId: this.thread.id,
        content: toSend,
        send: async (content) => {
          return this.thread.send(content)
        },
        split: splitDiscordMessage,
        logger: shadowLogger,
        context: `ShadowStreamRouter.flush thread=${this.thread.id}`,
        maxAttempts: 3,
      })

      if (result.droppedCount > 0) {
        shadowLogger.warn(
          `ShadowStreamRouter.flush dropped ${result.droppedCount} chunk(s) thread=${this.thread.id}`,
        )
      }

      if (result.unsentContent) {
        this.buffer = result.unsentContent + '\n' + this.buffer
      }
    } finally {
      this.isFlushing = false
    }
  }

  /**
   * Mark as complete (flushes and sends indicator)
   */
  async end() {
    await this.flush()
    // Ensure final flush happened
    if (this.buffer.trim()) await this.flush()

    try {
      const result = await safeSendDiscordText({
        channelId: this.thread.id,
        content: '✅ **Complete**',
        send: async (content) => {
          return this.thread.send(content)
        },
        split: splitDiscordMessage,
        logger: shadowLogger,
        context: `ShadowStreamRouter.end thread=${this.thread.id}`,
      })

      if (result.droppedCount > 0) {
        shadowLogger.warn(
          `ShadowStreamRouter.end dropped ${result.droppedCount} chunk(s) thread=${this.thread.id}`,
        )
      }

      if (result.unsentContent) {
        shadowLogger.warn(
          `ShadowStreamRouter.end left ${result.unsentContent.length} chars unsent thread=${this.thread.id}`,
        )
      }
    } catch (e) {
      shadowLogger.error('Failed to send complete marker', e)
    }
  }
}
