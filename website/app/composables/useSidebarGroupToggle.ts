import type { ContentNavigationItem } from '@nuxt/content'

function subtreeContainsPath(item: ContentNavigationItem, path: string): boolean {
  if (item.path === path) return true
  return item.children?.some(child => subtreeContainsPath(child, path)) ?? false
}

/**
 * Tracks which one sibling in a nav group is open, exclusive of the rest —
 * opening one closes whichever was open before. Opens the sibling whose
 * subtree contains the current route whenever the items become available or
 * the route changes, so client-side navigation into a different group is
 * followed. A manual toggle only changes `openIndex`, so it is never
 * overridden by this — only an actual route change re-syncs the open group.
 */
export function useSidebarGroupToggle(items: Ref<ContentNavigationItem[]> | ComputedRef<ContentNavigationItem[]>) {
  const route = useRoute()

  const openIndex = ref<number>()

  watch([items, () => route.path], ([value, path]) => {
    if (!value.length) return
    const activeIndex = value.findIndex(item => subtreeContainsPath(item, path))
    if (activeIndex !== -1) openIndex.value = activeIndex
  }, { immediate: true })

  function isOpen(index: number) {
    return openIndex.value === index
  }

  function toggle(index: number) {
    openIndex.value = openIndex.value === index ? undefined : index
  }

  return { isOpen, toggle }
}
