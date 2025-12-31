import type { Part } from '@opencode-ai/sdk'

export const ICONS = {
  THINK: '💭',
  TOOL: '🛠️',
  BASH: '⌨️',
  DIFF: '🧩',
  FILE: '📄',
  FINAL: '✅',
  ERROR: '❌',
}

function escapeFenceContent(text: string): string {
  // Prevent accidental closing of code fences
  return text.replace(/```/g, '\\`\\`\\`')
}

export function formatReasoning(text: string): string {
  // Use blockquote for reasoning
  const safeText = escapeFenceContent(text)
  return `\n${ICONS.THINK} **Reasoning**\n>>> ${safeText.replace(/\n/g, '\n> ')}\n`
}

export function formatToolCall(toolName: string, input: any): string {
  let content = `\n${ICONS.TOOL} **Tool Call**: \`${toolName}\``
  
  if (input) {
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    const safeInput = escapeFenceContent(inputStr)
    // If bash, use bash highlighting
    const lang = toolName === 'bash' ? 'bash' : 'json'
    content += `\n\`\`\`${lang}\n${safeInput}\n\`\`\``
  }
  return content
}

export function formatToolResult(toolName: string, output: any): string {
  let content = `\n${ICONS.TOOL} **Result** (\`${toolName}\`)`
  if (output) {
    if (typeof output === 'object' && output.summary) {
      content += `\n${output.summary}`
      if (output.preview) {
        const safePreview = escapeFenceContent(String(output.preview))
        content += `\n\`\`\`\n${safePreview}\n\`\`\``
      }
      return content
    }

    const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    const safeOutput = escapeFenceContent(outputStr)
    content += `\n\`\`\`\n${safeOutput}\n\`\`\``
  }
  return content
}

export function formatDiff(diffText: string): string {
  const safeDiff = escapeFenceContent(diffText)
  return `\n${ICONS.DIFF} **Diff**\n\`\`\`diff\n${safeDiff}\n\`\`\``
}

export function formatFinalAnswer(text: string): string {
  const safeText = escapeFenceContent(text)
  return `\n${ICONS.FINAL} **Final Answer**\n${safeText}`
}

export function formatError(error: string): string {
  const safeError = escapeFenceContent(error)
  return `\n${ICONS.ERROR} **Error**\n\`\`\`\n${safeError}\n\`\`\``
}

export function formatPartForShadow(type: string, content: any): string {
  switch (type) {
    case 'reasoning':
      return formatReasoning(content)
    case 'tool-input':
      return formatToolCall(content.tool, content.input)
    case 'tool-output':
      return formatToolResult(content.tool, content.output)
    case 'tool-error':
      return formatError(content.error)
    case 'text':
      return content // Just text
    case 'diff':
      return formatDiff(content)
    case 'final':
      return formatFinalAnswer(content)
    default:
      return ''
  }
}

/**
 * Heuristic to detect diffs in tool output or text
 */
export function isDiff(text: string): boolean {
  return text.startsWith('diff --git') || (text.includes('<<<<<<<') && text.includes('======='))
}
