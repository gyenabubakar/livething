const MARKETING_PAGES = ['/', '/cloudflare']

/** True on the full-width marketing pages, which get the landing header, nav and footer. */
export function useMarketingPage() {
  const route = useRoute()
  return computed(() => MARKETING_PAGES.includes(route.path))
}
