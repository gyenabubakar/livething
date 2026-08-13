import type { ContentNavigationItem } from '@nuxt/content'

function subtreeContainsPath(item: ContentNavigationItem, path: string): boolean {
  if (item.path === path) return true
  return item.children?.some(child => subtreeContainsPath(child, path)) ?? false
}

/**
 * Tracks which one sibling in a nav group is open, exclusive of the rest —
 * opening one closes whichever was open before. Starts on the sibling whose
 * subtree contains the current route, once the items are available.
 */
export function useSidebarGroupToggle(items: Ref<ContentNavigationItem[]> | ComputedRef<ContentNavigationItem[]>) {
  const route = useRoute()

  const openIndex = ref<number>()
  const initialized = ref(false)

  watch(items, (value) => {
    if (initialized.value || !value.length) return
    const activeIndex = value.findIndex(item => subtreeContainsPath(item, route.path))
    if (activeIndex !== -1) openIndex.value = activeIndex
    initialized.value = true
  }, { immediate: true })

  function isOpen(index: number) {
    return openIndex.value === index
  }

  function toggle(index: number) {
    openIndex.value = openIndex.value === index ? undefined : index
  }

  return { isOpen, toggle }
}
