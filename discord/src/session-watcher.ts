import type { OpencodeClient, Part } from '@opencode-ai/sdk'
import type Database from 'better-sqlite3'
import type { Client, ThreadChannel, Message as DiscordMessage } from 'discord.js'
import prettyMilliseconds from 'pretty-ms'
import { createLogger } from './logger.js'
import { isAbortError } from './utils.js'

const watcherLogger = createLogger('WATCHER')

type SessionState = {
  threadId: string
  title?: string
  currentParts: Part[]
  assistantMessageId?: string
  typingInterval?: NodeJS.Timeout
  sessionStartTime?: number
  usedModel?: string
  usedProviderID?: string
  tokensUsed: number
  sentPartIds: Set<string>
  sentMessageIds: Set<string>
  lastUserMessageId?: string
  lastCompletedMessageId?: string
  lastActivityAt: number
}

type SessionWatcherOptions = {
  directory: string
  getClient: () => OpencodeClient
  discordClient: Client
  getDatabase: () => Database.Database
  formatPart: (part: Part) => string
  sendThreadMessage: (thread: ThreadChannel, content: string) => Promise<DiscordMessage>
}

export class SessionWatcher {
  private directory: string
  private getClient: () => OpencodeClient
  private discordClient: Client
  private getBotDatabase: () => Database.Database
  private formatPart: (part: Part) => string
  private sendThreadMessage: (thread: ThreadChannel, content: string) => Promise<DiscordMessage>
  private abortController: AbortController | null = null
  private sessionStates = new Map<string, SessionState>()
  private reconnectAttempts = 0
  private maxReconnectDelay = 60000
  private isRunning = false
  private lastDiscordPrompt: string | null = null
  
  private pollingInterval: NodeJS.Timeout | null = null
  private pollingRate = 5000
  private activeThreshold = 10 * 60 * 1000 // 10 minutes

  constructor(opts: SessionWatcherOptions) {
    this.directory = opts.directory
    this.getClient = opts.getClient
    this.discordClient = opts.discordClient
    this.getBotDatabase = opts.getDatabase
    this.formatPart = opts.formatPart
    this.sendThreadMessage = opts.sendThreadMessage
  }

  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    watcherLogger.log(`Starting session watcher for ${this.directory}`)
    
    await this.populateSessionsFromDb()
    this.startPolling()
    await this.subscribe()
  }

  stop(): void {
    this.isRunning = false
    if (this.abortController) {
      this.abortController.abort('shutdown')
      this.abortController = null
    }
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval)
      this.pollingInterval = null
    }
    for (const state of this.sessionStates.values()) {
      if (state.typingInterval) clearInterval(state.typingInterval)
    }
    this.sessionStates.clear()
  }

  setLastDiscordPrompt(prompt: string) {
    this.lastDiscordPrompt = prompt
  }

  watchSession(sessionId: string, threadId: string, title?: string) {
    const state = this.getSessionState(sessionId, threadId)
    if (title) state.title = title
    state.lastActivityAt = Date.now()
  }

  private async populateSessionsFromDb() {
    try {
      const rows = this.getBotDatabase().prepare('SELECT thread_id, session_id FROM thread_sessions').all() as { thread_id: string, session_id: string }[]
      for (const row of rows) {
        try {
          const thread = await this.getThread(row.thread_id)
          if (!thread || !thread.parentId) continue
          
          const dirRow = this.getBotDatabase()
            .prepare('SELECT directory FROM channel_directories WHERE channel_id = ?')
            .get(thread.parentId) as { directory: string } | undefined
          
          if (dirRow && dirRow.directory === this.directory) {
             this.watchSession(row.session_id, row.thread_id)
          }
        } catch {}
      }
    } catch (error) {
      watcherLogger.error('Failed to populate sessions:', error)
    }
  }

  private async startPolling() {
    if (this.pollingInterval) return
    
    const runPoll = async () => {
      if (!this.isRunning) return
      try {
        await this.poll()
      } catch (e) {
        watcherLogger.error('Polling loop error:', e)
      }
      this.pollingInterval = setTimeout(runPoll, this.pollingRate)
    }
    
    runPoll()
  }

  private async poll() {
    if (!this.isRunning) return
    const now = Date.now()
    const activeSessions = Array.from(this.sessionStates.entries()).filter(([_, s]) => now - s.lastActivityAt < this.activeThreshold)
    
    // Process sessions sequentially to avoid OOM and server load
    for (const [id, state] of activeSessions) {
      if (!this.isRunning) break
      try {
        await Promise.race([
          this.pollSession(id, state),
          new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 30000))
        ])
      } catch (error: any) {
        if (error.message !== 'Timeout') {
          watcherLogger.error(`Poll ${id} failed: ${error.message}`)
        } else {
          watcherLogger.debug(`Poll ${id} timed out after 30s`)
        }
      }
    }
  }

  private async pollSession(sessionId: string, state: SessionState) {
    const response = await this.getClient().session.messages({ path: { id: sessionId } })
    if (!response.data || !Array.isArray(response.data)) return

    const thread = await this.getThread(state.threadId)
    if (!thread) return

    if (!state.title) {
       const info = await this.getClient().session.get({ path: { id: sessionId } })
       if (info.data?.title) state.title = info.data.title
    }

    for (const item of response.data) {
      const msg = (item.info || item) as any
      const parts = (item.parts || msg.parts || []) as any[]
      
      if (!msg.id) continue
      if (state.sentMessageIds.has(msg.id)) continue

      // Double check DB to be absolutely sure (persistence layer)
      const isSynced = this.getBotDatabase()
        .prepare('SELECT 1 FROM synced_messages WHERE opencode_message_id = ? AND thread_id = ?')
        .get(msg.id, state.threadId)
      if (isSynced) {
        state.sentMessageIds.add(msg.id)
        continue
      }

      if (msg.role === 'user') {
        const text = parts.filter(p => p.type === 'text').map(p => p.text).join('')
        if (this.lastDiscordPrompt && this.lastDiscordPrompt.trim() === text.trim()) {
          this.lastDiscordPrompt = null
          this.markMessageSynced(msg.id, state.threadId)
          state.sentMessageIds.add(msg.id)
          continue
        }
        await this.sendThreadMessage(thread, `📝 _Prompt from TUI:_\n> ${text.split('\n').join('\n> ')}`)
        this.markMessageSynced(msg.id, state.threadId)
        state.sentMessageIds.add(msg.id)
        state.lastActivityAt = Date.now()
      } else if (msg.role === 'assistant') {
        // Only sync if not currently being streamed via SSE
        if (state.sentPartIds.size > 0 && state.assistantMessageId === msg.id) continue
        
        // If not finished, show typing indicator
        if (!msg.finish) {
          this.startTyping(state, thread)
          state.lastActivityAt = Date.now()
          continue 
        }

        // Check if finished
        if (msg.finish) {
           await this.syncFullMessage(thread, msg, parts, state, sessionId)
           state.lastActivityAt = Date.now()
        }
      }
    }
  }

  private async syncFullMessage(thread: ThreadChannel, msg: any, parts: any[], state: SessionState, sessionId: string) {
    // Send all parts with icons
    for (const part of parts) {
      const content = this.formatPart(part)
      if (content.trim()) {
        await this.sendThreadMessage(thread, content)
      }
    }
    
    const duration = msg.time?.created && msg.time?.updated ? prettyMilliseconds(msg.time.updated - msg.time.created) : 'unknown'
    const footer = `_Synced from TUI_ ⋅ ${state.title || sessionId} ⋅ ${duration}`
    await this.sendThreadMessage(thread, footer)
    
    this.markMessageSynced(msg.id, state.threadId)
    state.sentMessageIds.add(msg.id)
  }

  public markMessageSynced(msgId: string, threadId: string, discordId: string = 'synced', sessionId?: string) {
    try {
      this.getBotDatabase()
        .prepare('INSERT OR REPLACE INTO synced_messages (opencode_message_id, thread_id, discord_message_id) VALUES (?, ?, ?)')
        .run(msgId, threadId, discordId)
      
      if (sessionId) {
        const state = this.sessionStates.get(sessionId)
        if (state) state.sentMessageIds.add(msgId)
      }
    } catch {}
  }

  private async subscribe(): Promise<void> {
    if (!this.isRunning) return
    this.abortController = new AbortController()
    try {
      const client = this.getClient()
      const eventsResult = await client.event.subscribe({ signal: this.abortController.signal })
      this.reconnectAttempts = 0
      watcherLogger.log(`Subscribed to events for ${this.directory}`)
      for await (const event of eventsResult.stream) {
        if (!this.isRunning) break
        await this.handleEvent(event)
      }
    } catch (error) {
      if (isAbortError(error, this.abortController?.signal)) return
      watcherLogger.error(`SSE error:`, error)
      await this.reconnect()
    }
  }

  private async reconnect() {
    if (!this.isRunning) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay)
    await new Promise(r => setTimeout(r, delay))
    if (this.isRunning) await this.subscribe()
  }

  private getSessionState(sessionId: string, threadId: string): SessionState {
    let state = this.sessionStates.get(sessionId)
    if (!state) {
      const sentPartIds = new Set<string>((this.getBotDatabase().prepare('SELECT part_id FROM part_messages WHERE thread_id = ?').all(threadId) as any[]).map(r => r.part_id))
      const sentMessageIds = new Set<string>((this.getBotDatabase().prepare('SELECT opencode_message_id FROM synced_messages WHERE thread_id = ?').all(threadId) as any[]).map(r => r.opencode_message_id))
      
      state = {
        threadId,
        currentParts: [],
        tokensUsed: 0,
        sentPartIds,
        sentMessageIds,
        lastActivityAt: Date.now()
      }
      this.sessionStates.set(sessionId, state)
    }
    return state
  }

  private async getThread(id: string) {
    try {
      const c = await this.discordClient.channels.fetch(id)
      return c?.isThread() ? c as ThreadChannel : null
    } catch { return null }
  }

  private async handleEvent(event: any) {
    const sessionId = this.extractSessionId(event)
    const threadId = sessionId ? (this.getBotDatabase().prepare('SELECT thread_id FROM thread_sessions WHERE session_id = ?').get(sessionId) as any)?.thread_id : null
    if (!threadId) return
    
    const thread = await this.getThread(threadId)
    if (!thread) return
    
    const state = this.getSessionState(sessionId!, threadId)
    state.lastActivityAt = Date.now()

    if (event.type === 'message.updated') await this.handleMessageUpdated(event, state, thread, sessionId!)
    else if (event.type === 'message.part.updated') await this.handlePartUpdated(event, state, thread, sessionId!)
    else if (event.type === 'session.error') await this.handleSessionError(event, state, thread)
    else if (event.type === 'permission.updated') await this.handlePermissionUpdated(event, state, thread)
  }

  private extractSessionId(e: any): string | null {
    return e.properties?.info?.sessionID || e.properties?.part?.sessionID || e.properties?.sessionID || null
  }

  private async handleMessageUpdated(event: any, state: SessionState, thread: ThreadChannel, sessionId: string) {
    const msg = event.properties.info
    state.sentMessageIds.add(msg.id)
    if (msg.role === 'assistant') {
      state.assistantMessageId = msg.id
      if (msg.finish && state.lastCompletedMessageId !== msg.id) {
        state.lastCompletedMessageId = msg.id
        await this.sendCompletionSummary(state, thread, sessionId)
        this.markMessageSynced(msg.id, state.threadId)
      }
    } else if (msg.role === 'user' && state.lastUserMessageId !== msg.id) {
      state.lastUserMessageId = msg.id
      const parts = (msg.parts || []) as any[]
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('')
      if (text && !(this.lastDiscordPrompt && this.lastDiscordPrompt.trim() === text.trim())) {
        await this.sendThreadMessage(thread, `📝 _Prompt from TUI:_\n> ${text.split('\n').join('\n> ')}`)
        this.markMessageSynced(msg.id, state.threadId)
      }
    }
  }

  private async handlePartUpdated(event: any, state: SessionState, thread: ThreadChannel, sessionId: string) {
    const part = event.properties.part
    if (part.messageID !== state.assistantMessageId) {
      state.assistantMessageId = part.messageID
      state.currentParts = []
    }
    if (state.sentPartIds.has(part.id)) return
    state.currentParts.push(part)
    if (part.type === 'step-start') this.startTyping(state, thread)
    else if (part.type === 'tool' && part.state.status === 'running') await this.sendPartMessage(part, state, thread)
    else if (part.type === 'reasoning') await this.sendPartMessage(part, state, thread)
    else if (part.type === 'step-finish') {
      for (const p of state.currentParts) await this.sendPartMessage(p, state, thread)
      this.stopTyping(state)
    }
  }

  private async sendPartMessage(part: Part, state: SessionState, thread: ThreadChannel) {
    if (state.sentPartIds.has(part.id)) return
    const content = this.formatPart(part) + '\n\n'
    if (!content.trim()) return
    const msg = await this.sendThreadMessage(thread, content)
    state.sentPartIds.add(part.id)
    this.getBotDatabase().prepare('INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)').run(part.id, msg.id, thread.id)
  }

  private async sendCompletionSummary(state: SessionState, thread: ThreadChannel, sessionId: string) {
    this.stopTyping(state)
    const duration = state.sessionStartTime ? prettyMilliseconds(Date.now() - state.sessionStartTime) : 'unknown'
    await this.sendThreadMessage(thread, `_Completed in ${duration}_ ⋅ ${state.title || sessionId}`)
    state.currentParts = []
    state.sessionStartTime = undefined
  }

  private startTyping(state: SessionState, thread: ThreadChannel) {
    if (state.typingInterval) clearInterval(state.typingInterval)
    thread.sendTyping().catch(() => {})
    state.typingInterval = setInterval(() => thread.sendTyping().catch(() => {}), 8000)
    state.sessionStartTime = Date.now()
  }

  private stopTyping(state: SessionState) {
    if (state.typingInterval) {
      clearInterval(state.typingInterval)
      state.typingInterval = undefined
    }
  }

  private async handleSessionError(e: any, state: SessionState, thread: ThreadChannel) {
    await this.sendThreadMessage(thread, `⨯ opencode error: ${e.properties.error?.data?.message || 'Unknown error'}`)
    this.stopTyping(state)
  }

  private async handlePermissionUpdated(e: any, state: SessionState, thread: ThreadChannel) {
    const p = e.properties
    const pattern = Array.isArray(p.pattern) ? p.pattern.join(', ') : p.pattern || ''
    await this.sendThreadMessage(thread, `⚠️ **Permission Required**\n**Action:** ${p.title}\n${pattern ? `**Pattern:** ${pattern}` : ''}\nUse \`/accept\` or \`/reject\`.`)
  }
}
