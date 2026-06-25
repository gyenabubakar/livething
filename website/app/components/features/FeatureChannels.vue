<script setup lang="ts">
import { Motion } from 'motion-v'

const prefersReducedMotion = ref(false)
const delivered = ref(false)
const demoRef = ref<HTMLElement>()

let cycleInterval: ReturnType<typeof setInterval> | undefined
let clearTimer: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | undefined

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Rooms', icon: 'i-ph-door-open-duotone' },
  { label: 'Auth gate', icon: 'i-ph-lock-key-duotone' },
  { label: 'Presence', icon: 'i-ph-users-three-duotone' },
]

// Three members of "general" + one outsider who never hears the broadcast.
const members = [
  { name: 'ada', delay: '0ms' },
  { name: 'lin', delay: '120ms' },
  { name: 'max', delay: '240ms' },
]
const outsider = { name: 'jo', room: 'lobby' }

function pulse() {
  delivered.value = true
  clearTimer = setTimeout(() => {
    delivered.value = false
  }, 2800)
}

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (prefersReducedMotion.value) {
    delivered.value = true
    return
  }

  if (demoRef.value) {
    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !cycleInterval) {
          pulse()
          cycleInterval = setInterval(pulse, 4500)
        }
      },
      { threshold: 0.3 },
    )
    observer.observe(demoRef.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (cycleInterval) clearInterval(cycleInterval)
  if (clearTimer) clearTimeout(clearTimer)
})
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5 }"
      :in-view-options="{ once: true }"
      class="mb-10"
    >
      <div>
        <p v-if="$slots.headline" class="section-label">
          <slot name="headline" mdc-unwrap="p" />
        </p>
        <div class="relative mb-5">
          <h2 class="section-title max-w-2xl">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </h2>
          <div aria-hidden="true" class="absolute inset-0 section-title max-w-2xl blur-xs animate-pulse pointer-events-none">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </div>
        </div>
        <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-muted">
          <slot name="description" mdc-unwrap="p" />
        </p>
        <div class="mt-5 flex flex-wrap gap-2">
          <span
            v-for="pill in pills"
            :key="pill.label"
            class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-muted"
          >
            <UIcon :name="pill.icon" class="size-3 text-emerald-500" />
            {{ pill.label }}
          </span>
        </div>
        <NuxtLink v-if="props.link" :to="props.link" class="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-dimmed hover:text-primary transition-colors">
          {{ props.linkLabel || 'Learn more' }}
          <UIcon name="i-ph-arrow-right-duotone" class="size-3" />
        </NuxtLink>
      </div>
    </Motion>

    <div class="grid gap-6 lg:grid-cols-2 *:min-w-0">
      <!-- Left: the channel, gated and scoped -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.1 }"
        :in-view-options="{ once: true }"
      >
        <div class="h-full overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
            <div class="flex gap-1.5">
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
            </div>
            <span class="ml-3 font-mono text-xs text-dimmed">chat.ts</span>
            <span class="ml-auto font-mono text-[10px] text-dimmed">server</span>
          </div>
          <div class="p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> room = base.<span class="text-amber-400">channel</span>(<span class="text-emerald-400">'general'</span>, {
  <span class="text-sky-400">outgoing</span>: { <span class="text-sky-400">emits</span>: { <span class="text-sky-400">message</span>: <span class="text-amber-400">t</span>&lt;<span class="text-sky-400">Msg</span>&gt;() } },
  <span class="text-sky-400">subscribe</span>: v.<span class="text-amber-400">object</span>({ token: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">check</span>: (ctx, { token }) => <span class="text-amber-400">assertMember</span>(token),
})

<span class="text-violet-400">const</span> handleSend = room.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'send'</span>, {
  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ text: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">run</span>(ctx, { text }) {
    <span class="text-dimmed">// scoped — only this room's members hear it</span>
    ctx.channel.<span class="text-amber-400">broadcast</span>(<span class="text-emerald-400">'message'</span>, { <span class="text-sky-400">from</span>: ctx.meta.username, text })
  },
})</code></pre>
          </div>
        </div>
      </Motion>

      <!-- Right: the broadcast reaches only members -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.2 }"
        :in-view-options="{ once: true }"
      >
        <div ref="demoRef" class="h-full overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
            <div class="flex gap-1.5">
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
            </div>
            <span class="ml-3 font-mono text-xs text-dimmed">room: general</span>
            <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-emerald-500">
              <span class="size-1.5 rounded-full bg-emerald-400" />
              3 online
            </span>
          </div>

          <div class="p-5 font-mono text-xs sm:text-sm">
            <!-- broadcast origin -->
            <div
              class="flex items-center gap-2 border border-pink-500/30 bg-pink-500/[0.07] px-3 py-2 transition-all duration-300"
              :class="delivered ? 'opacity-100' : 'opacity-50'"
            >
              <UIcon name="i-ph-broadcast-duotone" class="size-3.5 text-pink-400" :class="{ 'animate-pulse': delivered }" />
              <span class="text-pink-300">broadcast</span>
              <span class="text-dimmed">'message'</span>
              <span class="text-muted">"hey all"</span>
            </div>

            <!-- members receive it, staggered -->
            <div class="mt-3 space-y-2">
              <div
                v-for="m in members"
                :key="m.name"
                class="flex items-center gap-2.5"
              >
                <span class="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span class="w-8 text-highlighted">{{ m.name }}</span>
                <span
                  class="inline-flex items-center gap-1.5 text-emerald-400/90 transition-all duration-300"
                  :style="{ transitionDelay: delivered ? m.delay : '0ms' }"
                  :class="delivered ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'"
                >
                  <span class="text-dimmed">←</span> message <span class="text-muted">"hey all"</span>
                </span>
              </div>

              <!-- outsider never hears it -->
              <div class="flex items-center gap-2.5 opacity-45">
                <span class="size-1.5 rounded-full border border-muted shrink-0" />
                <span class="w-8 text-dimmed">{{ outsider.name }}</span>
                <span class="text-dimmed">— not in {{ 'general' }}, in {{ outsider.room }}</span>
              </div>
            </div>

            <div class="mt-5 border-t border-muted pt-3">
              <p class="text-xs text-dimmed">
                <span class="text-emerald-500">&#10003;</span> Membership lives on the server — the broadcast never reaches {{ outsider.name }}
              </p>
            </div>
          </div>
        </div>
      </Motion>
    </div>
  </section>
</template>
