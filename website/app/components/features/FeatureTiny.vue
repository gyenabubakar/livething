<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Tree-shakeable', icon: 'i-ph-scissors-duotone' },
  { label: 'Side-effect free', icon: 'i-ph-leaf-duotone' },
  { label: '~4.5 KB minimal', icon: 'i-ph-feather-duotone' },
]

/* ----------------------------------------------------------------------------
 * A minimal client is ~4.5 KB gzipped; pull in every primitive and it reaches
 * ~16 KB. We animate primitives snapping onto a bare socket — the bundle bar
 * grows only by what you add — then trim back to lean.
 * Only the two endpoints carry real numbers (4.5 KB / 16 KB); the steps in
 * between just show which primitives are on.
 * ------------------------------------------------------------------------- */

const MIN_KB = 4.5
const MAX_KB = 16
const BASE_PCT = (MIN_KB / MAX_KB) * 100 // bar width for the minimal socket

// The optional primitives you choose to ship — exact client factory names.
const primitives = [
  'reconnection',
  'keepalive',
  'quality',
  'channels',
  'requestResponse',
  'stream',
  'dedup',
  'replay',
]
const on = ref<boolean[]>(primitives.map(() => false))

function setOn(i: number, v: boolean) {
  const next = [...on.value]
  next[i] = v
  on.value = next
}
function resetState() {
  on.value = primitives.map(() => false)
}

const count = computed(() => on.value.filter(Boolean).length)
const barPct = computed(() => BASE_PCT + (count.value / primitives.length) * (100 - BASE_PCT))
const atMin = computed(() => count.value === 0)
const atMax = computed(() => count.value === primitives.length)
const sizeLabel = computed(() => {
  if (atMin.value) return '~4.5 KB'
  if (atMax.value) return '~16 KB'
  return `+${count.value}`
})
const sizeNote = computed(() => {
  if (atMin.value) return 'minimal socket'
  if (atMax.value) return 'every primitive'
  return count.value === 1 ? 'primitive added' : 'primitives added'
})

// Snap each primitive on, hold at full, then trim back to a lean three.
const events: TimedEvent[] = []
let t = 600
primitives.forEach((_, i) => {
  events.push({ at: t, run: () => setOn(i, true) })
  t += 520
})
t += 1400 // hold at "every primitive"
// trim the four you didn't need — back toward lean
;[2, 4, 6, 7].forEach((i) => {
  events.push({ at: t, run: () => setOn(i, false) })
  t += 480
})
const total = t + 1800

const prefersReducedMotion = ref(false)
const wireRef = ref<HTMLElement>()
const seq = useTimedSequence({ events, totalDuration: total, loop: true, onReset: resetState })

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) {
    on.value = primitives.map(() => true)
  }
})

useViewportActivation(wireRef, {
  threshold: 0.25,
  disabled: prefersReducedMotion,
  onEnter: () => {
    seq.start()
    seq.resume()
  },
  onExit: seq.pause,
})
</script>

<template>
  <section class="deferred-section pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + the client composition -->
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
            <div aria-hidden="true" v-play-when-visible class="absolute inset-0 section-title max-w-xl blur-xs animate-pulse pointer-events-none">
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
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
              <span class="size-1.5 rounded-full bg-sky-400" /> client
            </span>
            <span class="font-mono text-xs text-toned">app.client.ts</span>
          </div>
          <div class="flex-1 flex flex-col justify-center p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> socket = <span class="text-amber-400">client</span>&lt;<span class="text-sky-400">AppSocket</span>&gt;()(
  <span class="text-amber-400">connect</span>(<span class="text-emerald-400">'wss://api.example.com/ws'</span>),
<span class="block -mx-5 border-l-2 border-sky-500/70 bg-sky-500/10 pl-[calc(1.25rem-2px)] pr-5">  <span class="text-dimmed">// add a primitive, ship a primitive — nothing more</span>
  <span class="text-amber-400">reconnection</span>(),
  <span class="text-amber-400">channels</span>(),
  <span class="text-amber-400">stream</span>(),</span>)</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width: the bundle grows only by what you add -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="wireRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-package-duotone" class="size-4 text-primary" />
          <span class="font-mono text-xs sm:text-sm text-toned">bundle · you pay only for what you import</span>
          <span class="ml-auto inline-flex items-baseline gap-1.5 font-mono">
            <span class="text-sm tabular-nums transition-colors duration-300" :class="atMin ? 'text-emerald-300' : 'text-toned'">{{ sizeLabel }}</span>
            <span class="text-[11px] text-dimmed">{{ sizeNote }}</span>
          </span>
        </div>

        <div class="px-4 py-6 sm:px-6">
          <!-- the bar: core segment + the primitives you chose -->
          <div class="relative h-9 w-full overflow-hidden border border-muted bg-elevated/30">
            <!-- 16 KB marker -->
            <div class="absolute inset-y-0 right-0 w-px bg-muted" />
            <div class="bundle-bar absolute inset-y-0 left-0 flex items-center" :style="{ width: `${barPct}%` }">
              <div class="h-full w-full bg-gradient-to-r from-sky-500/40 to-primary/50 border-r border-primary/60" />
            </div>
            <div class="absolute inset-y-0 left-3 flex items-center font-mono text-[11px] text-default">
              core · connect
            </div>
            <div class="absolute inset-y-0 right-2 flex items-center font-mono text-[10px] text-dimmed">16 KB</div>
          </div>

          <!-- the primitives, lighting up as they ship -->
          <div class="mt-5 flex flex-wrap gap-2">
            <span
              v-for="(p, i) in primitives"
              :key="p"
              class="inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] transition-colors duration-300"
              :class="on[i]
                ? 'border-primary/50 bg-primary/[0.08] text-primary'
                : 'border-muted bg-elevated/20 text-dimmed'"
            >
              <UIcon
                :name="on[i] ? 'i-ph-plus-circle-duotone' : 'i-ph-circle-dashed'"
                class="size-3.5 shrink-0 transition-colors duration-300"
                :class="on[i] ? 'text-emerald-300' : 'text-dimmed'"
              />
              {{ p }}()
            </span>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-leaf-duotone" class="size-4 text-emerald-400 shrink-0" />
          every package is side-effect free — leave a primitive out and its code never ships
        </div>
      </div>
    </Motion>
  </section>
</template>

<style scoped>
.bundle-bar {
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
</style>
