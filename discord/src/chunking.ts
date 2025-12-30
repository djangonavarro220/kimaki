
/**
 * Split text into chunks that respect Discord's 2000 char limit
 * while preserving code fences.
 */
export function splitDiscordMessage(text: string, options: { limit?: number } = {}): string[] {
  const limit = options.limit || 2000
  const lines = text.split('\n')
  const chunks: string[] = []
  
  let currentChunk = ''
  let openFence: string | null = null // null if closed, string (lang) if open

  for (const line of lines) {
    // Check if line toggles a code fence
    const fenceMatch = line.match(/^```(\w*)/)
    if (fenceMatch) {
      if (openFence !== null) {
        openFence = null // closing fence
      } else {
        openFence = fenceMatch[1] || '' // opening fence (store language)
      }
    }

    // Process the line (split if too long)
    // Append newline between lines, but avoid double newlines after fences.
    if (currentChunk.length > 0 && !currentChunk.endsWith('\n')) {
        currentChunk += '\n'
    }
    
    let lineText = line
    
    while (lineText.length > 0) {
        // Calculate overhead
        // If we are in a fence (openFence !== null), we might need to close it: \n```
        // Note: we just added \n above if currentChunk > 0. 
        // If we split, we are mid-line, so we don't add \n.
        
        const closeOverhead = openFence !== null ? 4 : 0
        const space = limit - currentChunk.length - closeOverhead
        
        if (space <= 0) {
            // Flush
            if (openFence !== null) currentChunk += '\n```'
            chunks.push(currentChunk)
            currentChunk = ''
            if (openFence !== null) currentChunk += '```' + openFence + '\n'
            continue
        }
        
        if (lineText.length <= space) {
            currentChunk += lineText
            lineText = ''
        } else {
             // Check if fresh chunk
             const isFresh = currentChunk.length === 0 || (openFence !== null && currentChunk === '```' + openFence + '\n')
             
             if (!isFresh) {
                // Flush to get more space
                if (openFence !== null) currentChunk += '\n```'
                chunks.push(currentChunk)
                currentChunk = ''
                if (openFence !== null) currentChunk += '```' + openFence + '\n'
                continue
             }
             
             // Split
             const slice = lineText.slice(0, space)
             currentChunk += slice
             lineText = lineText.slice(space)
             
             // Flush
             if (openFence !== null) currentChunk += '\n```'
             chunks.push(currentChunk)
             
             // Reopen
             currentChunk = ''
             if (openFence !== null) currentChunk += '```' + openFence + '\n'
        }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}
