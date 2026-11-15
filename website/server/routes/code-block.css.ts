import { CODE_BLOCK_CSS } from '../utils/code-block'

export default defineEventHandler(event => {
  setHeader(event, 'content-type', 'text/css; charset=utf-8')

  return CODE_BLOCK_CSS
})
