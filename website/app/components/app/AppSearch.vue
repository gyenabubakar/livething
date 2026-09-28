<script setup lang="ts">
import type { ContentNavigationItem, PageCollections } from '@nuxt/content'

const props = defineProps<{
  navigation?: ContentNavigationItem[]
}>()

const appConfig = useAppConfig()
const { forced: forcedColorMode } = useDocusColorMode()
const { locale, isEnabled } = useDocusI18n()

const collectionName = computed(
  () => (isEnabled.value ? `docs_${locale.value}` : 'docs') as keyof PageCollections,
)
const useFts = appConfig.search.fts

const { data: files } = useFts
  ? { data: ref(null) }
  : useLazyAsyncData(
      `search_${collectionName.value}`,
      () => queryCollectionSearchSections(collectionName.value),
      {
        server: false,
        watch: [locale],
      },
    )

const {
  search,
  status: searchStatus,
  init,
} = useFts
  ? useSearchCollection(collectionName, { immediate: false, ignoredTags: ['style'] })
  : { search: undefined, status: ref(undefined), init: () => {} }

if (useFts) {
  const { open } = useContentSearch()
  watch(open, (value) => {
    if (value && searchStatus.value === 'idle') {
      init()
    }
  })
}

const links = computed(() =>
  useFts
    ? props.navigation
        ?.filter((item) => item.children?.length)
        .map((item) => ({
          label: item.title,
          icon: item.icon,
          to: item.children![0]!.path,
        }))
    : undefined,
)

function liftThemeGroup(viewport: HTMLElement): void {
  const themeGroup = Array.from(viewport.children).find((element) => {
    if (element.getAttribute('data-slot') !== 'group') return false
    return element.querySelector<HTMLElement>('[data-reka-collection-item]')?.tagName === 'BUTTON'
  })
  if (themeGroup && viewport.firstElementChild !== themeGroup) {
    viewport.prepend(themeGroup)
  }
}

function onWrapKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const viewport = document.querySelector<HTMLElement>('.search-panel [data-slot="viewport"]')
  if (!viewport) return
  const items = Array.from(viewport.querySelectorAll<HTMLElement>('[data-reka-collection-item]'))
  if (!items.length) return
  const highlighted = viewport.querySelector<HTMLElement>('[data-highlighted]')
  if (!highlighted) return
  const index = items.indexOf(highlighted)
  if (index === -1) return
  if (event.key === 'ArrowUp' && index !== 0) return
  if (event.key === 'ArrowDown' && index !== items.length - 1) return

  event.preventDefault()
  event.stopImmediatePropagation()
  document.querySelector<HTMLElement>('.search-panel [data-slot="input"]')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: event.key === 'ArrowUp' ? 'End' : 'Home', bubbles: true }),
  )
}

let panelObserver: MutationObserver | null = null

onMounted(() => {
  document.addEventListener('keydown', onWrapKeydown, true)

  panelObserver = new MutationObserver(() => {
    const viewport = document.querySelector<HTMLElement>('.search-panel [data-slot="viewport"]')
    if (viewport) {
      liftThemeGroup(viewport)
    }
  })
  panelObserver.observe(document.body, { childList: true, subtree: true })
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onWrapKeydown, true)
  panelObserver?.disconnect()
  panelObserver = null
})
</script>

<template>
  <LazyUContentSearch
    class="search-panel"
    :files="files"
    :search="search"
    :search-status="searchStatus"
    :links="links"
    :navigation="navigation"
    :color-mode="!forcedColorMode"
  />
</template>
