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

// Every block repeats the same icon sprite and core stylesheet in its shadow root (47 KB). Each block
// is sent without them, and the page adds them back once per block from this shared copy.
export const SHARED_CODE_BLOCK_HTML = `${SVGSpriteSheet}<style ${CORE_CSS_ATTRIBUTE}>${wrapCoreCSS('')}</style>`
const CORE_STYLE_PATTERN = new RegExp(`^<style ${CORE_CSS_ATTRIBUTE}(?:="")?>[\\s\\S]*?</style>`)

function withoutSharedHTML(html: string) {
  if (!html.startsWith(SVGSpriteSheet)) throw new Error('The rendered block does not start with the icon sprite.')

  return html.slice(SVGSpriteSheet.length).replace(CORE_STYLE_PATTERN, '')
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

      return withoutSharedHTML(result.prerenderedHTML)
    }
  }

  const result = await preloadFile({ file: { name, contents: code, lang: language }, options })

  return withoutSharedHTML(result.prerenderedHTML)
}
