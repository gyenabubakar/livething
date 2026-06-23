/**
 * 301 redirects for the documentation site, spread into `routeRules` in
 * `nuxt.config.ts`.
 *
 * Empty for now — the wskit docs are new, so there are no old URLs to redirect.
 * Add an entry when you rename or move a published page:
 *
 *   '/old/path': { redirect: { to: '/new/path', statusCode: 301 } },
 */

export const redirects: Record<string, { redirect: { to: string, statusCode: 301 } }> = {}
