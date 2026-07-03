// Overrides Docus's formatOgDescription (node_modules/docus/app/utils/ogImage.ts).
// The original strips every comma to keep the value short for the OG URL, which
// mangles the prose on the cards. Commas are fine: nuxt-og-image base64-encodes
// values with special characters and hashes any payload that overflows the URL
// cap, so URL length is a non-issue. The OG template already truncates the
// description to ~140 chars at a word boundary for display, so all this needs to
// do is keep the text intact and apply a light safety cap.

const OG_MAX = 150

export function formatOgDescription(
  _title: string | undefined,
  description: string | undefined,
): string | undefined {
  if (!description) return undefined
  if (description.length <= OG_MAX) return description

  // Trim to a sentence boundary if possible, else a word boundary.
  const truncated = description.slice(0, OG_MAX)
  const lastDot = truncated.lastIndexOf('.')
  if (lastDot > 0) return truncated.slice(0, lastDot + 1)

  const lastSpace = truncated.lastIndexOf(' ')
  return `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}…`
}
