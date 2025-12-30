/**
 * GlobalEventWatcher - Persistent SSE subscription for Discord sync
 * 
 * This class maintains a single SSE connection to the OpenCode server
 * and routes events to Discord threads based on session-to-thread mappings.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from '@opencode-ai/sdk'
import type { Client as DiscordClient, ThreadChannel, Message, TextChannel } from 'discord.js'
import type Database from 'better-sqlite3'
import prettyMilliseconds from 'pretty-ms'
import { createLogger } from './logger.js'
import { getOrCreateShadowChannel, createShadowThread, buildThreadLink } from './shadow-threads.js'
import { ShadowStreamRouter } from './stream-router.js'
import { formatPartForShadow } from './message-format.js'
import { splitDiscordMessage } from './chunking.js'

const watcherLogger = createLogger('WATCHER')

export interface WatcherDependencies {
  getDatabase: () => Database.Database
  getDiscordClient: () => DiscordClient
  sendThreadMessage: (thread: ThreadChannel, content: string) => Promise<Message>
  formatPart: (part: Part) => string
}

interface ThreadSession {
  thread_id: string
  session_id: string
  directory: string
}

interface PartMessage {
  part_id: string
  message_id: string
  thread_id: string
}

export class GlobalEventWatcher {
  private client: OpencodeClient | null = null
  private port: number
  private abortController: AbortController | null = null
  private isRunning = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private deps: WatcherDependencies

  // Track active typing per thread
  private typingIntervals = new Map<string, NodeJS.Timeout>()
  
  // Track accumulated parts per session
  private sessionParts = new Map<string, Part[]>()

  // Track message roles to distinguish User (TUI) vs Assistant
  private messageRoles = new Map<string, string>()

  // Track last completed assistant message per session to avoid duplicate summaries
  private lastCompletedMessageIds = new Map<string, string>()

  // Cache for model context limits
  private modelLimits = new Map<string, number>()

  // Cache for threads that failed to fetch (avoid repeated API calls)
  private failedThreads = new Set<string>()

  // Periodic backfill interval
  private backfillInterval: NodeJS.Timeout | null = null
  private static BACKFILL_INTERVAL_MS = 30000 // 30 seconds

  // Shadow thread management
  private shadowRouters = new Map<string, ShadowStreamRouter>() // messageId -> router
  private partOffsets = new Map<string, number>() // partId -> length sent
  private shadowThreadIds = new Map<string, string>() // messageId -> threadId
  private statusMessages = new Map<string, Message>() // messageId -> status message object
  private partStatuses = new Map<string, Set<string>>() // partId -> set of sent states ('input', 'output')

  // Track active interaction per thread (to reuse shadow thread across multiple assistant messages in one turn)
  private activeInteractions = new Map<string, {
    router: ShadowStreamRouter
    statusMessage: Message
    shadowThreadId: string
    messageIds: Set<string> // Track all message IDs associated with this interaction for cleanup
  }>()

  constructor(port: number, deps: WatcherDependencies) {
    this.port = port
    this.deps = deps
  }

  /**
   * Ensure a shadow thread exists for this message
   */
  private async ensureShadowThread(
    messageId: string,
    originThread: ThreadChannel,
    options: { postStatus?: boolean; trackInteraction?: boolean } = {},
  ): Promise<ShadowStreamRouter | null> {
    const { postStatus = true, trackInteraction = true } = options
    if (this.shadowRouters.has(messageId)) {
      return this.shadowRouters.get(messageId)!
    }

    // Check if we already have an active interaction for this thread
    const activeInteraction = this.activeInteractions.get(originThread.id)
    if (activeInteraction) {
      // Reuse existing router for this new message
      this.shadowRouters.set(messageId, activeInteraction.router)
      this.shadowThreadIds.set(messageId, activeInteraction.shadowThreadId)
      // Update status message map so finalization can find it
      if (activeInteraction.statusMessage) {
        this.statusMessages.set(messageId, activeInteraction.statusMessage)
      }
      
      // Track this message ID for later cleanup
      if (trackInteraction) {
        activeInteraction.messageIds.add(messageId)
      }
      
      return activeInteraction.router
    }

    // Determine parent channel
    const parentChannel = originThread.parent as TextChannel | null
    if (!parentChannel) {
        // Can happen if thread is in guild root? Unlikely for TextChannel threads.
        // Or if cached data is incomplete.
        // Try fetching
        try {
           await originThread.fetch()
        } catch {}
        if (!originThread.parent) {
           watcherLogger.error(`Thread ${originThread.id} has no parent channel`)
           return null
        }
    }

    // Get/Create Shadow Channel
    const shadowChannel = await getOrCreateShadowChannel(originThread.guild, parentChannel as TextChannel)
    if (!shadowChannel) return null

    // Create Shadow Thread
    const shadowThread = await createShadowThread(shadowChannel, originThread)
    if (!shadowThread) return null

    // Create Router
    const router = new ShadowStreamRouter(shadowThread)
    this.shadowRouters.set(messageId, router)
    this.shadowThreadIds.set(messageId, shadowThread.id)

    // Post Status Message in Main Thread
    let statusMsg: Message | undefined
    if (postStatus) {
        try {
            const link = buildThreadLink(originThread.guildId, shadowThread.id)
            statusMsg = await this.deps.sendThreadMessage(originThread, `🧠 Thinking... [View Process](${link})`)
            this.statusMessages.set(messageId, statusMsg)
        } catch (e) {
            watcherLogger.error('Failed to post status message:', e)
        }
    }

    // Store as active interaction
    if (trackInteraction && statusMsg) {
        this.activeInteractions.set(originThread.id, {
            router,
            statusMessage: statusMsg,
            shadowThreadId: shadowThread.id,
            messageIds: new Set([messageId])
        })
    }

    return router
  }

  /**
   * Start the watcher - subscribe to SSE and process events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      watcherLogger.log('Watcher already running')
      return
    }

    this.isRunning = true
    watcherLogger.log(`Starting GlobalEventWatcher on port ${this.port}`)

    // Create client
    this.client = createOpencodeClient({
      baseUrl: `http://localhost:${this.port}`,
      fetch: (request: Request) =>
        fetch(request, {
          // @ts-ignore
          timeout: false,
        }),
    })

    // Fetch model limits in background
    this.fetchModelLimits().catch(() => {})

    // Start SSE subscription loop immediately (don't wait for backfill)
    this.subscribeLoop()

    // Run backfill in background
    this.backfillMissedEvents().catch(e => {
      watcherLogger.error('Backfill failed:', e)
    })

    // Start periodic backfill for API-triggered messages (not emitted via SSE)
    this.startPeriodicBackfill()
  }

  /**
   * Start periodic backfill to catch API-triggered messages
   */
  private startPeriodicBackfill(): void {
    if (this.backfillInterval) return
    
    this.backfillInterval = setInterval(async () => {
      if (!this.isRunning || !this.client) return
      
      try {
        await this.backfillMissedEvents()
      } catch (e) {
        watcherLogger.error('Periodic backfill failed:', e)
      }
    }, GlobalEventWatcher.BACKFILL_INTERVAL_MS)
    
    watcherLogger.log(`Started periodic backfill every ${GlobalEventWatcher.BACKFILL_INTERVAL_MS / 1000}s`)
  }

  /**
   * Stop the watcher
   */
  stop(): void {
    watcherLogger.log('Stopping GlobalEventWatcher')
    this.isRunning = false
    
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.backfillInterval) {
      clearInterval(this.backfillInterval)
      this.backfillInterval = null
    }

    // Clear all typing indicators
    for (const [threadId, interval] of this.typingIntervals) {
      clearInterval(interval)
    }
    this.typingIntervals.clear()
  }

  /**
   * Fetch model context limits from the server
   */
  private async fetchModelLimits(): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${this.port}/provider`)
      if (!response.ok) return
      const data = await response.json() as any
      if (data.all && Array.isArray(data.all)) {
        for (const provider of data.all) {
          if (provider.models) {
            for (const [id, model] of Object.entries(provider.models)) {
              const limit = (model as any).limit?.context
              if (limit) this.modelLimits.set(id, limit)
            }
          }
        }
        watcherLogger.log(`Loaded context limits for ${this.modelLimits.size} models`)
      }
    } catch (e) {
      watcherLogger.error('Failed to fetch model limits:', e)
    }
  }

  /**
   * Get all linked sessions from the database
   */
  private getLinkedSessions(): ThreadSession[] {
    const db = this.deps.getDatabase()
    const rows = db.prepare(`
      SELECT ts.thread_id, ts.session_id, td.directory
      FROM thread_sessions ts
      LEFT JOIN thread_directories td ON ts.thread_id = td.thread_id
    `).all() as ThreadSession[]
    return rows
  }

  /**
   * Get thread for a session ID
   */
  private getThreadForSession(sessionId: string): string | null {
    const db = this.deps.getDatabase()
    // If a session is linked to multiple threads (e.g. reused/resumed),
    // pick the most recently created thread.
    const row = db.prepare(
      'SELECT thread_id FROM thread_sessions WHERE session_id = ? ORDER BY created_at DESC'
    ).get(sessionId) as { thread_id: string } | undefined
    return row?.thread_id ?? null
  }

  /**
   * Check if a part has already been sent
   */
  private isPartSent(partId: string): boolean {
    const db = this.deps.getDatabase()
    const row = db.prepare(
      'SELECT 1 FROM part_messages WHERE part_id = ?'
    ).get(partId)
    return !!row
  }

  /**
   * Record that a part was sent
   */
  private recordPartSent(partId: string, messageId: string, threadId: string): void {
    const db = this.deps.getDatabase()
    db.prepare(
      'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)'
    ).run(partId, messageId, threadId)
  }

  /**
   * Backfill missed events for all linked sessions
   */
  private async backfillMissedEvents(): Promise<void> {
    if (!this.client) return

    const sessions = this.getLinkedSessions()
    watcherLogger.log(`Backfilling ${sessions.length} linked sessions`)

    for (const session of sessions) {
      try {
        await this.backfillSession(session.session_id, session.thread_id)
      } catch (e) {
        watcherLogger.error(`Failed to backfill session ${session.session_id}:`, e)
      }
    }
    
    watcherLogger.log(`Backfill completed for ${sessions.length} sessions`)
  }

   /**
   * Backfill a single session
   * 
   * NOTE: Backfill routes assistant content to shadow threads only.
   * We also skip sessions that are actively streaming (have pending parts in sessionParts).
   */

  private async backfillSession(sessionId: string, threadId: string): Promise<void> {
    if (!this.client) return

    // Skip sessions that are actively streaming - their parts may be incomplete
    if (this.sessionParts.has(sessionId)) {
      return
    }

    const messagesResponse = await this.client.session.messages({
      path: { id: sessionId },
    })

    if (!messagesResponse.data) {
      watcherLogger.log(`No messages found for session ${sessionId}`)
      return
    }

    const messages = messagesResponse.data
    const thread = await this.getThread(threadId)
    if (!thread) return

    let backfilledCount = 0
    let backfillRouter: ShadowStreamRouter | null = null
    let backfillShadowThreadId: string | null = null
    const backfillMessageIds = new Set<string>()
    let interactionSentAny = false

    for (const message of messages) {
      if (message.info.role !== 'assistant') continue
      const messageId = message.info?.id
      if (!messageId) continue

      for (const part of message.parts) {
        if (this.isPartSent(part.id)) continue
        if (part.type === 'step-start' || part.type === 'step-finish') continue

        let formatted = ''

        if (part.type === 'reasoning' && part.text) {
          formatted = formatPartForShadow('reasoning', part.text)
        } else if (part.type === 'tool' && part.state) {
          if (part.state.status === 'running' && part.state.input) {
            formatted = formatPartForShadow('tool-input', { tool: part.tool, input: part.state.input })
          } else if (part.state.status === 'completed') {
            formatted = formatPartForShadow('tool-output', { tool: part.tool, output: part.state.output })
          } else if (part.state.status === 'error') {
            formatted = formatPartForShadow('tool-error', { error: part.state.error })
          }
        } else if (part.type === 'patch') {
          const diffText = (part as any).diff || (part as any).text
          if (diffText) formatted = formatPartForShadow('diff', diffText)
        } else if (part.type === 'text' && part.text) {
          formatted = formatPartForShadow('text', part.text)
        }

        if (!formatted.trim()) continue

        if (!backfillRouter) {
          backfillRouter = await this.ensureShadowThread(messageId, thread, { postStatus: false, trackInteraction: false })
          if (!backfillRouter) break
          backfillShadowThreadId = this.shadowThreadIds.get(messageId) ?? null
        }

        if (!backfillRouter) continue

        // Track message IDs for cleanup
        this.shadowRouters.set(messageId, backfillRouter)
        if (backfillShadowThreadId) this.shadowThreadIds.set(messageId, backfillShadowThreadId)
        backfillMessageIds.add(messageId)

        backfillRouter.append(formatted)
        interactionSentAny = true

        // Record as sent to avoid duplicate backfills
        const recordedMessageId = backfillShadowThreadId || messageId
        const recordedThreadId = backfillShadowThreadId || threadId
        this.recordPartSent(part.id, recordedMessageId, recordedThreadId)
        backfilledCount++
      }

      if (message.info.finish === 'stop' && backfillRouter) {
        if (interactionSentAny) {
          await backfillRouter.end()
        } else {
          await backfillRouter.flush()
        }

        for (const mid of backfillMessageIds) {
          this.shadowRouters.delete(mid)
          this.shadowThreadIds.delete(mid)
          this.statusMessages.delete(mid)
        }

        backfillRouter = null
        backfillShadowThreadId = null
        backfillMessageIds.clear()
        interactionSentAny = false
      }
    }

    if (backfillRouter && interactionSentAny) {
      await backfillRouter.flush()
      for (const mid of backfillMessageIds) {
        this.shadowRouters.delete(mid)
        this.shadowThreadIds.delete(mid)
        this.statusMessages.delete(mid)
      }
    }

    if (backfilledCount > 0) {
      watcherLogger.log(`Backfilled ${backfilledCount} parts for session ${sessionId}`)
    }
  }

  /**
   * Get Discord thread channel
   */
  private async getThread(threadId: string): Promise<ThreadChannel | null> {
    // Skip if we already know this thread doesn't exist
    if (this.failedThreads.has(threadId)) {
      return null
    }

    try {
      const channel = await this.deps.getDiscordClient().channels.fetch(threadId)
      if (channel?.isThread()) {
        return channel as ThreadChannel
      }
    } catch (e) {
      // Cache the failure to avoid repeated API calls
      this.failedThreads.add(threadId)
      watcherLogger.log(`Thread ${threadId} not found, marking as unavailable`)
    }
    return null
  }

  /**
   * Start typing indicator for a thread
   */
  private startTyping(threadId: string, thread: ThreadChannel): void {
    // Clear any existing interval
    this.stopTyping(threadId)

    // Send initial typing
    thread.sendTyping().catch(() => {})

    // Set up interval
    const interval = setInterval(() => {
      thread.sendTyping().catch(() => {})
    }, 8000)

    this.typingIntervals.set(threadId, interval)
  }

  /**
   * Stop typing indicator for a thread
   */
  private stopTyping(threadId: string): void {
    const interval = this.typingIntervals.get(threadId)
    if (interval) {
      clearInterval(interval)
      this.typingIntervals.delete(threadId)
    }
  }

  /**
   * Main SSE subscription loop with reconnection
   */
  private async subscribeLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.subscribe()
      } catch (e) {
        if (!this.isRunning) break
        watcherLogger.error('SSE subscription error:', e)
      }

      if (!this.isRunning) break

      // Wait before reconnecting
      watcherLogger.log('Reconnecting in 5 seconds...')
      await new Promise(resolve => {
        this.reconnectTimeout = setTimeout(resolve, 5000)
      })
    }
  }

  /**
   * Subscribe to SSE events
   */
  private async subscribe(): Promise<void> {
    if (!this.client) return

    this.abortController = new AbortController()

    watcherLogger.log('Subscribing to SSE events...')
    const eventsResult = await this.client.event.subscribe({
      signal: this.abortController.signal,
    })

    const events = eventsResult.stream
    watcherLogger.log('SSE subscription established')

    for await (const event of events) {
      if (!this.isRunning) break
      await this.handleEvent(event)
    }
  }

  /**
   * Handle an SSE event
   */
  private async handleEvent(event: any): Promise<void> {
    const sessionId = event.properties?.info?.sessionID 
      || event.properties?.part?.sessionID
      || event.properties?.sessionID

    if (!sessionId) return

    // Check if this session is linked to a Discord thread
    const threadId = this.getThreadForSession(sessionId)
    if (!threadId) return

    const thread = await this.getThread(threadId)
    if (!thread) return

    if (event.type === 'message.updated') {
      const msg = event.properties.info
      if (msg && msg.id && msg.role) {
        this.messageRoles.set(msg.id, msg.role)
        
        // Handle assistant message completion summary when message finishes with 'stop'
        if (msg.role === 'assistant' && msg.finish === 'stop') {
          const lastId = this.lastCompletedMessageIds.get(sessionId)
          if (lastId !== msg.id) {
            this.lastCompletedMessageIds.set(sessionId, msg.id)
            
            // 1. Send Final Text to MAIN thread (clean)
            const textParts = (msg.parts || [])
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text)
                .join('')
            
            if (textParts.trim()) {
                const chunks = splitDiscordMessage(textParts)
                for (const chunk of chunks) {
                    await this.deps.sendThreadMessage(thread, chunk)
                }
            }

            // 2. Finalize Shadow Thread
            // Retrieve router via message ID (mapped during ensureShadowThread)
            const router = this.shadowRouters.get(msg.id)
            
            // Get active interaction to cleanup ALL associated message IDs
            const activeInteraction = this.activeInteractions.get(thread.id)
            
            if (router) {
                await router.end()
                
                // Cleanup all mappings for this interaction
                if (activeInteraction) {
                    for (const mid of activeInteraction.messageIds) {
                        this.shadowRouters.delete(mid)
                        this.shadowThreadIds.delete(mid)
                        this.statusMessages.delete(mid)
                    }
                } else {
                    // Fallback for single message (shouldn't happen with new logic)
                    this.shadowRouters.delete(msg.id)
                    this.shadowThreadIds.delete(msg.id)
                    this.statusMessages.delete(msg.id)
                }
                
                // Clear active interaction for this thread
                this.activeInteractions.delete(thread.id)
            }

            // 3. Update/Delete Status Message in MAIN thread
            const statusMsg = activeInteraction?.statusMessage || this.statusMessages.get(msg.id)
            if (statusMsg) {
                try {
                    await statusMsg.delete()
                } catch {
                    // Ignore delete errors
                }
            }

            try {
              await this.sendCompletionSummary(thread, msg)
            } catch (e) {
              watcherLogger.error(`Failed to send completion summary:`, e)
            }
          }
        }
      }
    } else if (event.type === 'message.part.updated') {
      const part = event.properties.part as Part
      const role = this.messageRoles.get(part.messageID) || 'assistant'

      // Handle User messages (TUI prompts) immediately -> Echo to Main
      if (role === 'user' && part.type === 'text') {
        await this.sendPart(part, thread, threadId, role)
        return
      }

      // Handle Assistant messages -> Route to Shadow
      if (role === 'assistant') {
          // Initialize Shadow Thread if needed
          const router = await this.ensureShadowThread(part.messageID, thread)
          if (!router) return

          // --- Reasoning ---
          if (part.type === 'reasoning') {
             const currentLen = part.text?.length || 0
             const previousLen = this.partOffsets.get(part.id) || 0
             const delta = part.text?.slice(previousLen) || ''
             this.partOffsets.set(part.id, currentLen)
             
             if (delta) {
                 router.append(formatPartForShadow('reasoning', delta))
             }
          }
          
          // --- Text (Streaming) ---
          if (part.type === 'text') {
             const currentLen = part.text?.length || 0
             const previousLen = this.partOffsets.get(part.id) || 0
             const delta = part.text?.slice(previousLen) || ''
             this.partOffsets.set(part.id, currentLen)
             
             if (delta) {
                 router.append(delta) // Raw text append
             }
          }

          // --- Tool ---
          if (part.type === 'tool') {
             const statuses = this.partStatuses.get(part.id) || new Set()
             
             if (part.state.status === 'running' && part.state.input && !statuses.has('input')) {
                 router.append(formatPartForShadow('tool-input', { tool: part.tool, input: part.state.input }))
                 statuses.add('input')
                 this.partStatuses.set(part.id, statuses)
             }
             
             if (part.state.status === 'completed' && !statuses.has('output')) {
                 router.append(formatPartForShadow('tool-output', { tool: part.tool, output: part.state.output }))
                 statuses.add('output')
                 this.partStatuses.set(part.id, statuses)
             }
             
             if (part.state.status === 'error' && !statuses.has('error')) {
                 router.append(formatPartForShadow('tool-error', { error: part.state.error }))
                 statuses.add('error')
                 this.partStatuses.set(part.id, statuses)
             }
          }
          
          // --- Diff/Patch ---
          if (part.type === 'patch') {
              const diffText = (part as any).diff || (part as any).text
              const statuses = this.partStatuses.get(part.id) || new Set()
              
              if (diffText && !statuses.has('diff')) {
                  router.append(formatPartForShadow('diff', diffText))
                  statuses.add('diff')
                  this.partStatuses.set(part.id, statuses)
              }
          }

          // Typing indicator logic
          if (part.type === 'step-start') {
            this.startTyping(threadId, thread)
          } else if (part.type === 'step-finish') {
            this.stopTyping(threadId)
          }
      }

    } else if (event.type === 'session.completed') {
      this.stopTyping(threadId)
      this.sessionParts.delete(sessionId)
      this.activeInteractions.delete(threadId)
    } else if (event.type === 'session.error') {
      this.stopTyping(threadId)
      this.activeInteractions.delete(threadId)
      const errorMessage = event.properties?.error?.data?.message || 'Unknown error'
      try {
        await this.deps.sendThreadMessage(thread, `**Error:** ${errorMessage}`)
      } catch (e) {
        watcherLogger.error(`Failed to send error message:`, e)
      }
    }
  }

  /**
   * Send completion summary
   */
  private async sendCompletionSummary(thread: ThreadChannel, msg: any) {
    const tokens = msg.tokens || {}
    const info = msg
    
    let summaryParts: string[] = []

    if (tokens) {
      const input = (tokens.input || 0)
      const output = (tokens.output || 0)
      const reasoning = (tokens.reasoning || 0)
      const cacheRead = (tokens.cache?.read || 0)
      const total = input + output + reasoning
      
      if (total > 0) {
        let tokensStr = `Tokens: ${total.toLocaleString()}`
        
        // Calculate percentage
        const limit = this.modelLimits.get(info.modelID)
        if (limit) {
          const usage = input + cacheRead
          const percent = ((usage / limit) * 100).toFixed(1)
          tokensStr += ` (${percent}%)`
        }
        
        summaryParts.push(tokensStr)
      }
      
    }

    // Calculate duration if we have timing info
    if (info.time?.created && info.time?.completed) {
      const duration = info.time.completed - info.time.created
      if (duration > 0) {
         summaryParts.push(`Time: ${prettyMilliseconds(duration)}`)
      }
    }

    if (info.modelID) {
      summaryParts.push(`Model: ${info.modelID}`)
    }

    if (summaryParts.length > 0) {
      await this.deps.sendThreadMessage(thread, `-# Completed. ${summaryParts.join(' • ')}`)
    }
  }

  /**
   * Send a part to Discord (with deduplication)
   */
  private async sendPart(part: Part, thread: ThreadChannel, threadId: string, role: string = 'assistant'): Promise<void> {
    if (this.isPartSent(part.id)) return

    let content = this.deps.formatPart(part)
    
    // User message echo prevention and formatting
    if (role === 'user' && part.type === 'text') {
      // Fetch recent messages to check for echo
      const lastMessages = await thread.messages.fetch({ limit: 10 }).catch(() => null)
      
      // Find a recent message from a non-bot user that matches the content
      // This handles cases where attachments are appended to the prompt
      const partText = (part.text || '').trim()
      
      // Also check the thread starter message (it may have different format)
      const starterMessage = thread.id ? await thread.fetchStarterMessage().catch(() => null) : null
      
      const recentUserMessage = lastMessages?.find(msg => {
        // Must be from a non-bot user
        if (msg.author.bot) return false
        // Must be recent (within last 2 minutes)
        const age = Date.now() - msg.createdTimestamp
        if (age > 120000) return false
        // Content should match or be a prefix of the part text (attachments get appended)
        const msgContent = msg.content.trim()
        // Check both directions: Discord content is prefix of part, or exact match
        return partText === msgContent || partText.startsWith(msgContent) || msgContent.startsWith(partText)
      })
      
      // Also check starter message
      const starterMatch = starterMessage && !starterMessage.author.bot && (
        partText === starterMessage.content.trim() ||
        partText.startsWith(starterMessage.content.trim()) ||
        starterMessage.content.trim().startsWith(partText)
      )
      
      if (recentUserMessage || starterMatch) {
        // Echo detected - message originated from Discord, not TUI
        const matchedMsg = recentUserMessage || starterMessage!
        this.recordPartSent(part.id, matchedMsg.id, threadId)
        return
      }

      // Not an echo (TUI message), quote it
      content = `-# 📝 _Prompt from TUI:_\n> ${content.split('\n').join('\n> ')}`
    }

    // Ensure content is a string and not empty
    if (typeof content !== 'string' || !content.trim()) return

    try {
      const message = await this.deps.sendThreadMessage(thread, content + '\n\n')
      this.recordPartSent(part.id, message.id, threadId)
    } catch (e) {
      watcherLogger.error(`Failed to send part ${part.id}:`, e)
    }
  }
}
