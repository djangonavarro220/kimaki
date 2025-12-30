import {
  ChannelType,
  type Guild,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'

// In-memory counter for response threads per session thread
// Key: originThreadId, Value: current counter
const threadCounters = new Map<string, number>()

export async function getOrCreateShadowChannel(guild: Guild, originChannel: TextChannel): Promise<TextChannel | null> {
  const shadowName = `logs-${originChannel.name}`.slice(0, 100) // Discord channel name limit
  
  // 1. Try to find existing channel
  const existing = guild.channels.cache.find(
    c => c.name === shadowName && c.type === ChannelType.GuildText
  ) as TextChannel | undefined

  if (existing) return existing

  // 2. Create if not exists
  try {
    const newChannel = await guild.channels.create({
      name: shadowName,
      type: ChannelType.GuildText,
      parent: originChannel.parentId, // Keep in same category if possible
      topic: `Shadow logs for #${originChannel.name}`,
    })
    return newChannel
  } catch (err) {
    console.error('Failed to create shadow channel:', err)
    return null
  }
}

export async function createShadowThread(
  shadowChannel: TextChannel, 
  originThread: ThreadChannel
): Promise<ThreadChannel | null> {
  // Increment counter
  const currentCount = (threadCounters.get(originThread.id) || 0) + 1
  threadCounters.set(originThread.id, currentCount)

  const threadName = `${originThread.name} #${currentCount}`.slice(0, 100)

  try {
    const thread = await shadowChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 60, // 1 hour default (no "none" option usually)
      reason: `Shadow thread for ${originThread.name}`,
    })
    return thread
  } catch (err) {
    console.error('Failed to create shadow thread:', err)
    return null
  }
}

export function buildThreadLink(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`
}
