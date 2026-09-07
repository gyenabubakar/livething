<script lang="ts">
const LINE_HEIGHT = 23
const HEADER_HEIGHT = 40
const BLOCK_PADDING = 16

const BLOCK_CSS = `
:host {
  --diffs-font-family: var(--font-mono, "DM Mono", monospace);
  --diffs-font-size: 14.5px;
  --diffs-line-height: ${LINE_HEIGHT}px;
}
[data-metadata] {
  padding-right: 30px;
}
`
</script>

<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import UPre from '#ui/components/prose/Pre.vue'

const props = defineProps<{
  code?: string
  language?: string
  filename?: string
  highlights?: number[]
  hideHeader?: boolean
  meta?: string
  icon?: string
  class?: unknown
  ui?: Record<string, unknown>
}>()

const route = useRoute()
const enabled = computed(() => route.path !== '/')
const code = computed(() => (props.code ?? '').replace(/\n+$/, ''))
const language = computed(() => props.language || 'text')
const showHeader = computed(() => !!props.filename && !props.hideHeader)
const name = computed(() => props.filename || `snippet.${language.value}`)
const height = computed(
  () => code.value.split('\n').length * LINE_HEIGHT + (showHeader.value ? HEADER_HEIGHT : 0) + BLOCK_PADDING,
)

const colorMode = useColorMode()
const themeType = computed<'light' | 'dark'>(() => (colorMode.value === 'dark' ? 'dark' : 'light'))
const { copy, copied } = useClipboard()
const appConfig = useAppConfig()

const root = ref<HTMLElement>()
const container = ref<HTMLElement>()
const visible = ref(false)

let instance: { setThemeType: (type: 'light' | 'dark') => void, cleanUp: () => void } | undefined
let observer: IntersectionObserver | undefined

async function draw() {
  if (!container.value) return

  const { File } = await import('@pierre/diffs')
  const file = new File({
    theme: { light: 'pierre-light', dark: 'pierre-dark-soft' },
    themeType: themeType.value,
    overflow: 'scroll' as const,
    disableFileHeader: !showHeader.value,
    unsafeCSS: BLOCK_CSS,
  })
  file.render({
    file: { name: name.value, contents: code.value, lang: language.value },
    containerWrapper: container.value,
  })
  instance = file
}

watch(themeType, type => instance?.setThemeType(type))

onMounted(() => {
  if (!enabled.value || !root.value) return
  if (typeof IntersectionObserver === 'undefined') {
    visible.value = true
    nextTick(draw)
    return
  }

  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      visible.value = true
      observer?.disconnect()
      observer = undefined
      nextTick(draw)
    },
    { rootMargin: '200px 0px' },
  )
  observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = undefined
  instance?.cleanUp()
  instance = undefined
})
</script>

<template>
  <UPre
    v-if="!enabled"
    v-bind="props"
  >
    <slot />
  </UPre>

  <div
    v-else
    ref="root"
    class="not-prose group relative my-5"
    :style="{ minHeight: `${height}px` }"
  >
    <div v-show="visible" ref="container" class="diffs-block" />
    <USkeleton v-if="!visible" class="w-full" :style="{ height: `${height}px` }" />

    <UButton
      :icon="copied ? appConfig.ui.icons.copyCheck : appConfig.ui.icons.copy"
      color="neutral"
      variant="outline"
      size="sm"
      aria-label="Copy code"
      class="absolute top-1.5 right-1.5 z-10 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      :class="copied ? 'opacity-100' : 'opacity-0'"
      @click="copy(code)"
    />
  </div>
</template>

<style scoped>
.diffs-block :deep(diffs-container) {
  display: block;
  overflow: hidden;
  border: 1px solid var(--ui-border-muted);
}
</style>
