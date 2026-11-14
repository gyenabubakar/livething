import { CORE_CSS_ATTRIBUTE, parsePatchFiles, SVGSpriteSheet, wrapCoreCSS } from '@pierre/diffs'
import { preloadFile, preloadFileDiff } from '@pierre/diffs/ssr'

export interface CodeBlockInput {
  code: string
  language: string
  filename?: string
  hideHeader?: boolean
}

const BLOCK_CSS = `
:host {
  --diffs-font-family: var(--font-mono, "DM Mono", monospace);
  --diffs-font-size: 14.5px;
  --diffs-line-height: 23px;
}
`

// The icon sprite and the core stylesheet are 47 KB and the same for every block. They are served once
// from two files that the browser caches, and each block's shadow root links to them.
export const CODE_BLOCK_CSS_PATH = '/code-block.css'
export const CODE_BLOCK_SPRITE_PATH = '/code-block-sprite.svg'
export const CODE_BLOCK_CSS = wrapCoreCSS('')
export const CODE_BLOCK_SPRITE = SVGSpriteSheet.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')

const CORE_STYLE_PATTERN = new RegExp(`^<style ${CORE_CSS_ATTRIBUTE}(?:="")?>[\\s\\S]*?</style>`)

function withSharedAssets(html: string) {
  if (!html.startsWith(SVGSpriteSheet)) throw new Error('The rendered block does not start with the icon sprite.')

  return `<link rel="stylesheet" href="${CODE_BLOCK_CSS_PATH}">${html
    .slice(SVGSpriteSheet.length)
    .replace(CORE_STYLE_PATTERN, '')
    .replaceAll('href="#diffs-icon-', `href="${CODE_BLOCK_SPRITE_PATH}#diffs-icon-`)}`
}

// A docs diff can be a sketch with no valid hunk headers. It then shows as a plain `diff` file.
function parseDiff(code: string, name: string) {
  try {
    return parsePatchFiles(code, name, true)[0]?.files[0]
  } catch {
    return undefined
  }
}

export async function highlightCodeBlock({ code, language, filename, hideHeader }: CodeBlockInput) {
  const name = filename || `snippet.${language}`
  const options = {
    theme: { light: 'pierre-light', dark: 'pierre-dark-soft' },
    themeType: 'system',
    overflow: 'scroll',
    disableFileHeader: !filename || hideHeader,
    unsafeCSS: BLOCK_CSS,
  } as const

  if (language === 'diff' || language === 'patch') {
    const fileDiff = parseDiff(code, name)

    if (fileDiff) {
      const result = await preloadFileDiff({
        fileDiff,
        options: { ...options, diffStyle: 'unified', lineDiffType: 'none' },
      })

      return withSharedAssets(result.prerenderedHTML)
    }
  }

  const result = await preloadFile({ file: { name, contents: code, lang: language }, options })

  return withSharedAssets(result.prerenderedHTML)
}
