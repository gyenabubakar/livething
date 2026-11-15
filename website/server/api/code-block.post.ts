import { highlightCodeBlock } from '../utils/code-block'
import type { CodeBlockInput } from '../utils/code-block'

export default defineEventHandler(async (event) => {
  const input = await readBody<Partial<CodeBlockInput>>(event)
  if (typeof input?.code !== 'string' || typeof input.language !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'code and language must be strings' })
  }

  return { html: await highlightCodeBlock(input as CodeBlockInput) }
})
