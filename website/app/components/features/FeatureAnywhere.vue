<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Cloudflare · Node · Bun · Deno', icon: 'i-ph-globe-hemisphere-west-duotone' },
  { label: 'Your own infrastructure', icon: 'i-ph-hard-drives-duotone' },
  { label: 'Same typed contract', icon: 'i-ph-link-duotone' },
]

// The server adapters. Swapping the import is the only change between them.
const adapters = [
  { name: 'Cloudflare', slug: 'cloudflare', detail: 'Durable Objects', logo: 'i-logos-cloudflare-workers-icon' },
  { name: 'Node', slug: 'node', detail: '', logo: 'i-logos-nodejs-icon' },
  { name: 'Bun', slug: 'bun', detail: '', logo: 'i-logos-bun' },
  { name: 'Deno', slug: 'deno', detail: '', logo: 'i-logos-deno' },
]

const current = ref(0)
const active = computed(() => adapters[current.value]!)

function resetState() {
  current.value = 0
}
const events: TimedEvent[] = [
  { at: 1900, run: () => { current.value = 1 } },
  { at: 3800, run: () => { current.value = 2 } },
  { at: 5700, run: () => { current.value = 3 } },
]
const total = 7600

const prefersReducedMotion = ref(false)
const wireRef = ref<HTMLElement>()
const seq = useTimedSequence({ events, totalDuration: total, loop: true, onReset: resetState })

let observer: IntersectionObserver | undefined
onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) return
  if (!wireRef.value) { seq.start(); return }
  observer = new IntersectionObserver(([e]) => {
    if (e?.isIntersecting) { seq.start(); observer?.disconnect() }
  }, { threshold: 0.25 })
  observer.observe(wireRef.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + the adapter swap -->
    <div class="grid gap-8 lg:grid-cols-2 lg:gap-12 *:min-w-0 items-stretch">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
      >
        <div>
          <p v-if="$slots.headline" class="section-label">
            <slot name="headline" mdc-unwrap="p" />
          </p>
          <div class="relative mb-5">
            <h2 class="section-title max-w-xl">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </h2>
            <div aria-hidden="true" class="absolute inset-0 section-title max-w-xl blur-xs animate-pulse pointer-events-none">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </div>
          </div>
          <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-toned [&_code]:font-mono [&_code]:text-primary [&_code]:bg-elevated/60 [&_code]:border [&_code]:border-muted [&_code]:px-1 [&_code]:py-0.5">
            <slot name="description" mdc-unwrap="p" />
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <span
              v-for="pill in pills"
              :key="pill.label"
              class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-toned"
            >
              <UIcon :name="pill.icon" class="size-3.5 text-emerald-400" />
              {{ pill.label }}
            </span>
          </div>
          <NuxtLink v-if="props.link" :to="props.link" class="group mt-6 inline-flex items-center gap-1.5 font-mono text-xs text-primary transition-colors">
            <span class="border-b border-primary/50 pb-0.5 transition-colors group-hover:border-primary">{{ props.linkLabel || 'Learn more' }}</span>
            <UIcon name="i-ph-arrow-right-duotone" class="size-4 transition-transform group-hover:translate-x-0.5" />
          </NuxtLink>
        </div>
      </Motion>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.15 }"
        :in-view-options="{ once: true }"
        class="h-full"
      >
        <div class="h-full flex flex-col overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">room.server.ts</span>
          </div>
          <div class="flex-1 flex flex-col justify-center p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-dimmed">// only this import changes per runtime</span>
<span class="text-violet-400">import</span> { server } <span class="text-violet-400">from</span> <span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-emerald-400">'@wskit/server-</span><span class="text-primary transition-colors duration-300">{{ active.slug }}</span><span class="text-emerald-400">'</span></span>
<span class="text-violet-400">import</span> { chatHandler } <span class="text-violet-400">from</span> <span class="text-emerald-400">'./chat'</span>

<span class="text-violet-400">export const</span> ChatRoom = <span class="text-amber-400">server</span>(chatHandler)</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width: one definition, deployable to each runtime -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="wireRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-globe-hemisphere-west-duotone" class="size-4 text-primary" />
          <span class="font-mono text-xs sm:text-sm text-toned">one definition · your own infrastructure</span>
          <span class="ml-auto font-mono text-[11px] text-dimmed">no service to rent</span>
        </div>

        <div class="grid items-stretch md:grid-cols-[minmax(0,0.9fr)_1.4fr]">
          <!-- the single definition -->
          <div class="flex items-center justify-center border-b border-muted/50 p-6 md:border-b-0 md:border-r">
            <div class="w-full max-w-xs border border-emerald-400/40 bg-emerald-500/[0.06] p-4">
              <div class="flex items-center gap-2">
                <UIcon name="i-ph-cube-duotone" class="size-5 text-emerald-300" />
                <span class="font-mono text-sm text-toned">chatHandler</span>
              </div>
              <div class="mt-3 space-y-1 font-mono text-[11px] text-dimmed">
                <div><span class="text-sky-300">channels</span> · <span class="text-sky-300">requests</span> · <span class="text-sky-300">streams</span></div>
                <div class="text-toned">your contract, handlers & client —</div>
                <div class="text-toned">identical on every target</div>
              </div>
            </div>
          </div>

          <!-- the runtimes it deploys to -->
          <div class="divide-y divide-muted/40">
            <div
              v-for="(rt, i) in adapters"
              :key="rt.name"
              class="relative flex items-center gap-3 px-4 py-3.5 sm:px-5 transition-colors duration-300"
              :class="current === i ? 'bg-primary/[0.05]' : ''"
            >
              <!-- connector from the definition; flows for the active target -->
              <div class="relative hidden h-px w-8 shrink-0 sm:block">
                <div class="absolute inset-0 transition-colors duration-300" :class="current === i ? 'bg-primary/50' : 'bg-muted'" />
                <div v-if="current === i" class="wire-flow absolute inset-0 -top-px h-0.5" />
              </div>

              <UIcon :name="rt.logo" class="size-6 shrink-0 transition-opacity duration-300" :class="current === i ? 'opacity-100' : 'opacity-70'" />
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-sm transition-colors duration-300" :class="current === i ? 'text-default' : 'text-toned'">{{ rt.name }}</span>
                  <span v-if="rt.detail" class="font-mono text-[11px] text-dimmed">{{ rt.detail }}</span>
                </div>
                <div class="font-mono text-[11px] truncate transition-colors duration-300" :class="current === i ? 'text-primary' : 'text-dimmed'">@wskit/server-{{ rt.slug }}</div>
              </div>

              <span
                class="ml-auto shrink-0 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide transition-opacity duration-300"
                :class="current === i ? 'text-primary opacity-100' : 'opacity-0'"
              >
                <UIcon name="i-ph-arrow-bend-down-left-duotone" class="size-3.5" /> deployed
              </span>
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-laptop-duotone" class="size-4 text-sky-400 shrink-0" />
          and the client is runtime-agnostic too — browser, Node, React Native, any custom environment
        </div>
      </div>
    </Motion>
  </section>
</template>

<style scoped>
.wire-flow {
  background-image: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-color-primary-500) 90%, transparent) 0 4px,
    transparent 4px 12px
  );
  background-size: 12px 100%;
  animation: wire-move 0.5s linear infinite;
}

@keyframes wire-move {
  to {
    background-position: 12px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wire-flow {
    animation: none;
  }
}
</style>
