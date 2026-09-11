<script lang="ts">
const LINE_HEIGHT = 23

const BLOCK_CSS = `
:host {
  --diffs-font-family: var(--font-mono, "DM Mono", monospace);
  --diffs-font-size: 14.5px;
  --diffs-line-height: ${LINE_HEIGHT}px;
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
const isDiff = computed(() => language.value === 'diff' || language.value === 'patch')
const showHeader = computed(() => !!props.filename && !props.hideHeader)
const name = computed(() => props.filename || `snippet.${language.value}`)

const colorMode = useColorMode()
const themeType = computed<'light' | 'dark'>(() => (colorMode.value === 'dark' ? 'dark' : 'light'))
const { copy, copied } = useClipboard()
const appConfig = useAppConfig()

const container = ref<HTMLElement>()
const block = ref<HTMLElement>()
const visible = ref(false)
const rendered = ref(false)
const placeholderHeight = computed(() => {
  const lines = Math.max(1, code.value.split('\n').length)
  const headerHeight = showHeader.value ? 38 : 0

  return `${lines * LINE_HEIGHT + headerHeight + 2}px`
})

let instance: { setThemeType: (type: 'light' | 'dark') => void, cleanUp: () => void } | undefined
let observer: IntersectionObserver | undefined

async function draw() {
  if (!container.value) return

  const { File, FileDiff, parsePatchFiles } = await import('@pierre/diffs')

  if (isDiff.value) {
    let fileDiff

    try {
      fileDiff = parsePatchFiles(code.value, name.value, true)[0]?.files[0]
    } catch {
      fileDiff = undefined
    }

    if (fileDiff) {
      const diff = new FileDiff({
        theme: { light: 'pierre-light', dark: 'pierre-dark-soft' },
        themeType: themeType.value,
        diffStyle: 'unified',
        lineDiffType: 'none',
        overflow: 'scroll' as const,
        disableFileHeader: !showHeader.value,
        unsafeCSS: BLOCK_CSS,
      })
      diff.render({ fileDiff, containerWrapper: container.value })
      instance = diff
      return
    }
  }

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

async function render() {
  if (visible.value) return

  visible.value = true
  await nextTick()
  await draw()
  rendered.value = true
  observer?.disconnect()
  observer = undefined
}

onMounted(() => {
  if (!enabled.value) return

  if (!block.value || typeof IntersectionObserver === 'undefined') {
    void render()
    return
  }

  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) void render()
    },
    { rootMargin: '200px 0px' },
  )
  observer.observe(block.value)
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
    ref="block"
    class="not-prose group relative my-5"
    :style="{ minHeight: rendered ? undefined : placeholderHeight }"
  >
    <div v-if="visible" ref="container" class="diffs-block" />

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
