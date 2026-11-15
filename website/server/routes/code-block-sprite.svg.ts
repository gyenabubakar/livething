import { CODE_BLOCK_SPRITE } from '../utils/code-block'

export default defineEventHandler(event => {
  setHeader(event, 'content-type', 'image/svg+xml; charset=utf-8')

  return CODE_BLOCK_SPRITE
})
