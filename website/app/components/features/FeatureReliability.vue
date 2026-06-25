<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Reconnect', icon: 'i-ph-arrows-clockwise-duotone' },
  { label: 'Buffer offline sends', icon: 'i-ph-stack-duotone' },
  { label: 'Replay & dedup', icon: 'i-ph-clock-counter-clockwise-duotone' },
]

/* ----------------------------------------------------------------------------
 * One full drop-and-recover lifecycle, looping:
 * live → drop → offline (buffer + miss) → reconnect → restore (flush + replay)
 * → synced.
 * ------------------------------------------------------------------------- */

type Phase = 'live' | 'drop' | 'offline' | 'reconnect' | 'restore' | 'synced'
const RANK: Record<Phase, number> = {
  live: 0, drop: 1, offline: 2, reconnect: 3, restore: 4, synced: 5,
}
const phase = ref<Phase>('live')
const wireRef = ref<HTMLElement>()

// Sends the user makes while offline — buffered, then flushed on reconnect.
const outbox = [
  { event: 'send', detail: '"on my way"' },
  { event: 'send', detail: '"be there at 6"' },
]
// Messages the server emitted while the client was away — replayed on reconnect.
const missed = [
  { seq: 41, event: 'order-update', dup: false },
  { seq: 42, event: 'order-update', dup: false },
  { seq: 42, event: 'order-update', dup: true },
]

function resetState() {
  phase.value = 'live'
}

const events: TimedEvent[] = [
  { at: 1200, run: () => { phase.value = 'drop' } },
  { at: 1900, run: () => { phase.value = 'offline' } },
  { at: 4000, run: () => { phase.value = 'reconnect' } },
  { at: 4700, run: () => { phase.value = 'restore' } },
  { at: 6200, run: () => { phase.value = 'synced' } },
]
const total = 6200 + 2600

const seq = useTimedSequence({ events, totalDuration: total, loop: true, onReset: resetState })

let observer: IntersectionObserver | undefined
const prefersReducedMotion = ref(false)

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) { phase.value = 'synced'; return }
  if (!wireRef.value) { seq.start(); return }
  observer = new IntersectionObserver(([e]) => {
    if (e?.isIntersecting) { seq.start(); observer?.disconnect() }
  }, { threshold: 0.25 })
  observer.observe(wireRef.value)
})
onBeforeUnmount(() => observer?.disconnect())

const r = computed(() => RANK[phase.value])
const broken = computed(() => phase.value === 'drop' || phase.value === 'offline')
const buffered = computed(() => r.value >= RANK.offline)
const flushed = computed(() => r.value >= RANK.restore)
const restoring = computed(() => phase.value === 'restore')
const synced = computed(() => phase.value === 'synced')

const status = computed(() => {
  switch (phase.value) {
    case 'live': return { label: 'connected', tone: 'ok' }
    case 'drop': return { label: 'connection lost', tone: 'bad' }
    case 'offline': return { label: 'reconnecting…', tone: 'warn' }
    case 'reconnect': return { label: 'reconnected', tone: 'ok' }
    case 'restore': return { label: 'catching up…', tone: 'warn' }
    case 'synced': return { label: 'in sync', tone: 'ok' }
  }
  return { label: '', tone: 'ok' }
})
const toneText: Record<string, string> = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-red-300' }
const toneDot: Record<string, string> = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-red-400' }
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + the stacked client -->
    <div class="grid gap-8 lg:grid-cols-2 lg:gap-12 *:min-w-0 items-start">
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
          <NuxtLink v-if="props.link" :to="props.link" class="group mt-6 inline-flex items-center gap-2 border border-primary/40 bg-primary/[0.06] px-4 py-2 font-mono text-xs text-primary hover:bg-primary/15 hover:border-primary/60 transition-colors">
            {{ props.linkLabel || 'Learn more' }}
            <UIcon name="i-ph-arrow-right-duotone" class="size-4 transition-transform group-hover:translate-x-0.5" />
          </NuxtLink>
        </div>
      </Motion>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.15 }"
        :in-view-options="{ once: true }"
      >
        <div class="overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
              <span class="size-1.5 rounded-full bg-sky-400" /> client
            </span>
            <span class="font-mono text-xs text-toned">app.client.ts</span>
          </div>
          <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> socket = <span class="text-amber-400">client</span>&lt;<span class="text-sky-400">AppSocket</span>&gt;()(
  <span class="text-amber-400">connect</span>(<span class="text-emerald-400">'wss://api.example.com/ws'</span>),
  <span class="text-amber-400">reconnection</span>(),               <span class="text-dimmed">// get back after a drop</span>
  <span class="text-amber-400">keepalive</span>(),                  <span class="text-dimmed">// notice a dead socket fast</span>
  <span class="text-amber-400">buffering</span>({ enabled: <span class="text-violet-400">true</span> }),  <span class="text-dimmed">// keep offline sends</span>
  <span class="text-amber-400">dedup</span>(),                      <span class="text-dimmed">// no duplicates on catch-up</span>
  <span class="text-amber-400">replay</span>(),                     <span class="text-dimmed">// fill in what you missed</span>
)</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width wire: the drop-and-recover lifecycle -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="wireRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-pulse-duotone" class="size-4 text-primary" />
          <span class="font-mono text-xs sm:text-sm text-toned">live socket · survives a dropped connection</span>
          <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] transition-colors duration-300" :class="toneText[status.tone]">
            <span class="size-1.5 rounded-full transition-colors duration-300" :class="[toneDot[status.tone], status.tone !== 'ok' ? 'animate-pulse' : '']" />
            {{ status.label }}
          </span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="size-7 inline-flex items-center justify-center text-muted hover:text-default focus:text-default focus:outline-none transition-colors"
              :aria-label="seq.paused.value ? 'Play animation' : 'Pause animation'"
              :disabled="!seq.started.value"
              @click="seq.toggle"
            >
              <UIcon :name="seq.paused.value ? 'i-ph-play-duotone' : 'i-ph-pause-duotone'" class="size-3.5" />
            </button>
            <button
              type="button"
              class="size-7 inline-flex items-center justify-center text-muted hover:text-default focus:text-default focus:outline-none transition-colors"
              aria-label="Restart animation"
              :disabled="!seq.started.value"
              @click="seq.restart"
            >
              <UIcon name="i-ph-arrow-counter-clockwise-duotone" class="size-3.5" />
            </button>
          </div>
        </div>

        <div class="grid grid-cols-[minmax(0,1fr)_1.5fr_minmax(0,1fr)] items-stretch">
          <!-- Client: buffers sends made while offline -->
          <div class="px-4 py-5 sm:px-5">
            <div class="flex items-center gap-2 mb-3">
              <UIcon name="i-ph-laptop-duotone" class="size-5 text-sky-300" />
              <span class="font-mono text-sm text-toned">client</span>
              <span class="ml-auto font-mono text-[10px] tracking-wide uppercase transition-colors duration-300" :class="flushed ? 'text-emerald-300' : (buffered ? 'text-amber-300' : 'text-dimmed')">
                {{ flushed ? 'flushed' : (buffered ? 'buffering' : 'outbox') }}
              </span>
            </div>
            <div class="space-y-2 min-h-[5.5rem]">
              <div
                v-for="(m, i) in outbox"
                :key="m.detail"
                class="flex items-center gap-2.5 border px-3 py-2 font-mono text-xs sm:text-[13px] leading-4 transition-all duration-300"
                :class="!buffered ? 'border-muted/30 opacity-0 -translate-x-2'
                  : (flushed ? 'border-emerald-400/45 bg-emerald-500/[0.08] opacity-100 translate-x-0'
                  : 'border-amber-400/45 bg-amber-500/[0.07] opacity-100 translate-x-0')"
                :style="{ transitionDelay: `${i * 120}ms` }"
              >
                <UIcon :name="flushed ? 'i-ph-check-duotone' : 'i-ph-clock-duotone'" class="size-3.5 shrink-0" :class="flushed ? 'text-emerald-300' : 'text-amber-300'" />
                <span class="text-toned">{{ m.event }}</span>
                <span class="text-muted truncate">{{ m.detail }}</span>
              </div>
            </div>
          </div>

          <!-- The wire: breaks on drop, rejoins on reconnect -->
          <div class="relative flex flex-col items-center justify-center px-2 py-5 bg-elevated/20">
            <div class="relative flex w-full items-center">
              <div class="h-px flex-1 transition-colors duration-300" :class="broken ? 'bg-red-500/40' : 'bg-emerald-500/40'" />
              <div
                class="mx-2 flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] whitespace-nowrap transition-colors duration-300"
                :class="broken ? 'border-red-500/50 bg-red-500/10 text-red-300'
                  : (restoring ? 'border-amber-400/50 bg-amber-500/10 text-amber-200'
                  : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200')"
              >
                <UIcon
                  :name="broken ? 'i-ph-plugs-duotone' : (restoring ? 'i-ph-arrows-clockwise-duotone' : 'i-ph-plug-charging-duotone')"
                  class="size-3.5"
                  :class="restoring ? 'animate-spin' : ''"
                />
                {{ broken ? 'disconnected' : (restoring ? 'syncing' : 'connected') }}
              </div>
              <div class="relative h-px flex-1 overflow-hidden transition-colors duration-300" :class="broken ? 'bg-red-500/40' : 'bg-emerald-500/40'">
                <div class="reliab-flow absolute inset-0 -top-px h-0.5" :class="restoring ? 'opacity-100' : 'opacity-0'" />
              </div>
            </div>
            <p class="mt-4 font-mono text-[10px] text-dimmed transition-opacity duration-300" :class="phase === 'offline' ? 'opacity-100' : 'opacity-0'">
              retry with backoff · 1s → 2s → 4s
            </p>
          </div>

          <!-- Server: holds what you missed, replays it -->
          <div class="px-4 py-5 sm:px-5 border-l border-muted/50">
            <div class="flex items-center gap-2 mb-3">
              <span class="font-mono text-sm text-toned">server</span>
              <UIcon name="i-ph-hard-drives-duotone" class="size-5 text-emerald-300" />
              <span class="ml-auto font-mono text-[10px] tracking-wide uppercase transition-colors duration-300" :class="flushed ? 'text-emerald-300' : (buffered ? 'text-amber-300' : 'text-dimmed')">
                {{ flushed ? 'replayed' : (buffered ? 'held' : 'log') }}
              </span>
            </div>
            <div class="space-y-2 min-h-[5.5rem]">
              <div
                v-for="(m, i) in missed"
                :key="i"
                class="flex items-center gap-2 border px-3 py-2 font-mono text-xs sm:text-[13px] leading-4 transition-all duration-300"
                :class="!buffered ? 'border-muted/30 opacity-0 translate-x-2'
                  : (flushed && m.dup ? 'border-red-400/40 bg-red-500/[0.06] opacity-100 translate-x-0'
                  : (flushed ? 'border-emerald-400/45 bg-emerald-500/[0.08] opacity-100 translate-x-0'
                  : 'border-amber-400/45 bg-amber-500/[0.07] opacity-100 translate-x-0'))"
                :style="{ transitionDelay: `${i * 120}ms` }"
              >
                <span class="shrink-0 tabular-nums" :class="flushed && m.dup ? 'text-red-300 line-through' : 'text-violet-300'">#{{ m.seq }}</span>
                <span class="truncate" :class="flushed && m.dup ? 'text-dimmed line-through' : 'text-toned'">{{ m.event }}</span>
                <span class="ml-auto shrink-0 text-[10px]" :class="flushed && m.dup ? 'text-red-300' : (flushed ? 'text-emerald-300' : 'text-amber-300')">
                  {{ flushed ? (m.dup ? 'deduped' : 'replayed') : 'held' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-shield-check-duotone" class="size-4 text-emerald-400 shrink-0" />
          the socket drops and comes back — your offline sends flush, the messages you missed replay, and nothing arrives twice
        </div>
      </div>
    </Motion>
  </section>
</template>

<style scoped>
.reliab-flow {
  background-image: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-color-primary-500) 90%, transparent) 0 5px,
    transparent 5px 18px
  );
  background-size: 18px 100%;
  animation: reliab-flow-bg 0.55s linear infinite;
  transition: opacity 0.3s ease;
}
@keyframes reliab-flow-bg {
  to { background-position: 18px 0; }
}
</style>
