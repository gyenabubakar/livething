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
const enabled = route.path !== '/'
const code = (props.code ?? '').replace(/\n+$/, '')

// The server highlights the block (server/api/code-block.post.ts), so the highlighter never ships
// to the browser. A prerendered page carries the result in its payload.
async function highlight() {
  try {
    const { html } = await $fetch('/api/code-block', {
      method: 'POST',
      body: {
        code,
        language: props.language || 'text',
        filename: props.filename,
        hideHeader: props.hideHeader,
      },
    })

    return html
  } catch (error) {
    console.error('Could not highlight a code block, so it stays plain.', error)
    return null
  }
}

// The key must not depend on where the block sits in the component tree: `useId()` changes after a
// client-side navigation, so the page's prerendered payload would not be found. FNV-1a of the
// block's content is the same on the server and in the browser.
function blockKey() {
  let hash = 0x811c9dc5
  for (const char of `${props.language}\0${props.filename}\0${props.hideHeader}\0${code}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  }

  return `${(hash >>> 0).toString(36)}-${code.length}`
}

const [{ data: sharedHTML }, { data: shadowHTML }] = enabled
  ? await Promise.all([
      useAsyncData('code-block-shared', () => $fetch('/api/code-block-shared').then(r => r.html)),
      useAsyncData(`code-block-${blockKey()}`, highlight),
    ])
  : [{ data: ref(null) }, { data: ref(null) }]

const markup = computed(() =>
  sharedHTML.value == null || shadowHTML.value == null
    ? null
    : `<diffs-container><template shadowrootmode="open">${sharedHTML.value}${shadowHTML.value}</template></diffs-container>`,
)

// The HTML parser turns the template into a shadow root on the first page load. After a client-side
// navigation the template comes from innerHTML, which leaves it inert, so attach it here.
const wrapper = ref<HTMLElement>()

function attachShadowRoot() {
  const host = wrapper.value?.querySelector('diffs-container')
  const template = host?.querySelector('template')
  if (!host || !template) return

  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  shadowRoot.replaceChildren(template.content)
  template.remove()
}

onMounted(attachShadowRoot)
onUpdated(attachShadowRoot)

const { copy, copied } = useClipboard()
const appConfig = useAppConfig()
</script>

<template>
  <div
    v-if="markup"
    class="not-prose group relative my-5"
  >
    <div
      ref="wrapper"
      class="diffs-block"
      v-html="markup"
    />

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

  <UPre
    v-else
    v-bind="props"
  >
    <slot />
  </UPre>
</template>

<style scoped>
.diffs-block :deep(diffs-container) {
  display: block;
  overflow: hidden;
  border: 1px solid var(--ui-border-muted);
  color-scheme: light;
}

.dark .diffs-block :deep(diffs-container) {
  color-scheme: dark;
}
</style>
