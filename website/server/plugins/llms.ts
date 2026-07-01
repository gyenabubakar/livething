/**
 * Strip MDC component syntax from the generated `llms-full.txt` so the plain-text
 * output reads as prose, not markup. `@nuxt/content` fills the full-text contents
 * with each page's raw markdown, MDC and all; this runs afterward and cleans it.
 *
 * Block fences (`::note`, `:::card-group`, and their closing `::`) are dropped
 * while their inner content stays; inline components (`:badge[Label]`, `:icon{…}`)
 * are unwrapped to their label or removed. Fenced code blocks are left untouched.
 */
function stripMdc(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inCode = false

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode
      out.push(line)
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    if (/^\s*:{2,}\s*$/.test(line)) continue
    if (/^\s*:{2,}[A-Za-z]/.test(line)) continue

    out.push(
      line
        .replace(/:[A-Za-z][\w-]*\[([^\]]*)\](\{[^}]*\})?/g, '$1')
        .replace(/:[A-Za-z][\w-]*\{[^}]*\}/g, ''),
    )
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('llms:generate:full', (_event, _options, contents: string[]) => {
    for (let index = 0; index < contents.length; index += 1) {
      contents[index] = stripMdc(contents[index])
    }
  })
})
