<script setup lang="ts">
import type { Collections } from '@nuxt/content'

const ONE_YEAR = 60 * 60 * 24 * 365

const route = useRoute()

// The page each track was left on, so switching tracks returns you where you were rather
// than to that track's first page every time.
const lastPage = Object.fromEntries(
  tracks.map(t => [
    t.value,
    useCookie<string | undefined>(`lt-track-${t.value}`, {
      maxAge: ONE_YEAR,
      sameSite: 'lax',
    }),
  ]),
) as Record<Track, Ref<string | undefined>>

const error = useError()
const activeTrack = ref<Track>(trackForPath(route.path) ?? 'core')

watch(() => route.path, (path) => {
  const track = trackForPath(path)
  if (track) activeTrack.value = track
}, { immediate: true })

// Remember a page only in the browser and only once it has loaded, so a 404 is never a tab's
// target and a first visit to the server sets no cookie. `route.path` changes before a missing
// page fails, so the save waits for `page:finish`.
const nuxtApp = useNuxtApp()

function rememberPage() {
  const track = trackForPath(route.path)
  if (track && !error.value) lastPage[track]!.value = route.path
}

let stopRemembering: (() => void) | undefined
onMounted(() => {
  rememberPage()
  stopRemembering = nuxtApp.hook('page:finish', rememberPage)
})
onBeforeUnmount(() => stopRemembering?.())

// Where each tab would take you, worked out up front rather than at click time.
const trackTargets = computed(() => {
  const out = {} as Record<Track, string>
  for (const t of tracks) {
    const remembered = lastPage[t.value]!.value
    out[t.value] = remembered && trackForPath(remembered) === t.value ? remembered : t.to
  }
  return out
})

function onTrackChange(value: string | number) {
  const track = value as Track
  // Set at once, so the pill slides on click instead of after the next page loads.
  activeTrack.value = track
  navigateTo(trackTargets.value[track])
}

// The first switch to a track is the slow one: nothing about its page has been fetched, so
// the click stalls before anything moves. Warm the track the reader is NOT on once the page
// is idle, so the tab is already paid for by the time it is clicked.
//
// The docs page (`app/pages/[[lang]]/[...slug].vue`) keys its data `page<path>` and
// `surround<path>`. The result goes into `nuxtApp.static.data`, because that is where
// useAsyncData looks once hydration is over.
const { locale, isEnabled: i18nEnabled } = useDocusI18n()

async function warmRoute(path: string) {
  const track = trackForPath(path)
  if (!track || nuxtApp.static.data[`page${path}`] !== undefined) return

  const collection = (i18nEnabled.value ? `docs_${locale.value}` : 'docs') as keyof Collections
  try {
    const [page, surround] = await nuxtApp.runWithContext(() => Promise.all([
      queryCollection(collection).path(path).first(),
      queryCollectionItemSurroundings(collection, path, { fields: ['description'] })
        .where('path', 'LIKE', `/${track}/%`),
    ])) as [unknown, unknown]

    // A remembered page that was renamed or deleted: forget it, so the tab opens the
    // track's first page.
    if (!page) {
      lastPage[track]!.value = undefined
      return
    }

    nuxtApp.static.data[`page${path}`] = page
    nuxtApp.static.data[`surround${path}`] = surround
  }
  catch {
    // Warming only saves time; if it fails, the tab loads its page on the first click.
  }
}

onNuxtReady(() => {
  for (const t of tracks) {
    if (t.value === activeTrack.value) continue
    const to = trackTargets.value[t.value]
    void preloadRouteComponents(to)
    void preloadPayload(to)
    void warmRoute(to)
  }
})
</script>

<template>
  <UTabs
    :model-value="activeTrack"
    :items="tracks"
    :content="false"
    color="neutral"
    variant="pill"
    size="sm"
    aria-label="Select a track"
    class="shrink-0"
    :ui="{
      list: 'h-8 items-center rounded-md border border-accented bg-elevated px-0.5 py-0',
      trigger: [
        'h-full px-2 py-0 data-[state=active]:text-white',
        // Before hydration Reka has no sliding indicator yet, so the active trigger draws
        // its own pill. Give it the indicator's colour so nothing flashes on load.
        'in-[[data-slot=list]:not(:has([data-slot=indicator]))]:data-[state=active]:before:bg-neutral-600',
      ].join(' '),
      indicator: 'inset-y-0.5 rounded-sm bg-neutral-600',
      // The icon is drawn in the slot below, so it and the label centre as one group.
      leadingIcon: 'hidden',
      label: 'm-0',
    }"
    @update:model-value="onTrackChange"
  >
    <template #default="{ item }">
      <span class="flex items-center gap-1.5">
        <UIcon
          :name="item.icon"
          class="size-4 shrink-0"
        />
        <span class="whitespace-nowrap">{{ item.label }}</span>
      </span>
    </template>
  </UTabs>
</template>
