import type { ThreadChannel } from 'discord.js'
import { splitDiscordMessage } from './chunking.js'

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
    this.tryFlush().catch(err => console.error('Error in auto-flush:', err))
  }

  /**
   * Send a complete component as its own message (no streaming).
   */
  async sendComponent(text: string) {
    if (!text || !text.trim()) return
    await this.flush()

    try {
      const chunks = splitDiscordMessage(text)
      for (const chunk of chunks) {
        await this.thread.send(chunk)
      }
    } catch (e) {
      console.error('Shadow thread component send error:', e)
    }
  }
  
  private async tryFlush() {
    if (this.isFlushing) return

    const now = Date.now()
    // Flush if > 1800 chars OR (> 0 chars AND time interval passed)
    if (this.buffer.length > 1800 || (this.buffer.length > 0 && now - this.lastFlush > this.FLUSH_INTERVAL)) {
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
      const chunks = splitDiscordMessage(toSend)
      for (const chunk of chunks) {
        await this.thread.send(chunk)
      }
    } catch (e) {
      console.error('Shadow thread send error:', e)
      // Put back in buffer? No, risky loop. Just log error.
      // this.buffer = toSend + this.buffer // Prepend back? Maybe too dangerous.
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
       await this.thread.send('✅ **Complete**')
    } catch(e) { console.error('Failed to send complete marker', e)}
  }
}
