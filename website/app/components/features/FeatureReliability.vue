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
 * Messages flow server → client. The socket drops (flow pauses, the server
 * holds what it can't send), then reconnects (the held messages replay across),
 * and a duplicate that slips through on the messy reconnect is dropped by dedup.
 * ------------------------------------------------------------------------- */

type Phase = 'live' | 'drop' | 'reconnect' | 'replay' | 'synced'
const phase = ref<Phase>('live')
const wireRef = ref<HTMLElement>()
const prefersReducedMotion = ref(false)

type MState = 'idle' | 'held' | 'flying' | 'arrived' | 'dropped'
interface Msg { seq: number; lane: number; dup?: boolean }
const messages: Msg[] = [
  { seq: 41, lane: 0 },
  { seq: 42, lane: 1 },
  { seq: 43, lane: 0 },
  { seq: 44, lane: 1 },
  { seq: 44, lane: 2, dup: true },
]
const mstate = ref<MState[]>(messages.map(() => 'idle'))

function set(i: number, s: MState) {
  const next = [...mstate.value]
  next[i] = s
  mstate.value = next
}
function resetState() {
  phase.value = 'live'
  mstate.value = messages.map(() => 'idle')
}

const events: TimedEvent[] = [
  { at: 400, run: () => set(0, 'flying') },
  { at: 1150, run: () => set(0, 'arrived') },
  { at: 1500, run: () => set(1, 'flying') },
  { at: 2250, run: () => set(1, 'arrived') },
  { at: 2750, run: () => { phase.value = 'drop' } },
  { at: 3050, run: () => set(2, 'held') },
  { at: 3450, run: () => set(3, 'held') },
  { at: 4900, run: () => { phase.value = 'reconnect' } },
  { at: 5300, run: () => { phase.value = 'replay'; set(2, 'flying') } },
  { at: 5700, run: () => set(3, 'flying') },
  { at: 6050, run: () => set(2, 'arrived') },
  { at: 6200, run: () => set(4, 'flying') },
  { at: 6450, run: () => set(3, 'arrived') },
  { at: 6950, run: () => set(4, 'dropped') },
  { at: 7400, run: () => { phase.value = 'synced' } },
]
const total = 7400 + 2800

const seq = useTimedSequence({ events, totalDuration: total, loop: true, onReset: resetState })

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) {
    phase.value = 'synced'
    mstate.value = ['arrived', 'arrived', 'arrived', 'arrived', 'dropped']
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

const broken = computed(() => phase.value === 'drop')
const flowing = computed(() => phase.value === 'live' || phase.value === 'replay')
const heldMsgs = computed(() => messages.filter((_, i) => mstate.value[i] === 'held'))
const receivedMsgs = computed(() => messages.filter((_, i) => mstate.value[i] === 'arrived'))

function onWire(i: number): boolean {
  const s = mstate.value[i]
  return s === 'flying' || s === 'dropped'
}
function chipLeft(i: number): string {
  const s = mstate.value[i] ?? 'idle'
  return (s === 'flying' || s === 'arrived' || s === 'dropped') ? '4%' : '86%'
}

const status = computed(() => {
  switch (phase.value) {
    case 'live': return { label: 'connected', tone: 'ok' }
    case 'drop': return { label: 'disconnected', tone: 'bad' }
    case 'reconnect': return { label: 'reconnected', tone: 'ok' }
    case 'replay': return { label: 'catching up…', tone: 'warn' }
    case 'synced': return { label: 'in sync', tone: 'ok' }
  }
  return { label: '', tone: 'ok' }
})
const toneText: Record<string, string> = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-red-300' }
const toneDot: Record<string, string> = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-red-400' }
</script>

<template>
  <section class="deferred-section pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + the stacked client -->
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
  <span class="text-amber-400">reconnection</span>(),               <span class="text-dimmed">// get back after a disconnect</span>
  <span class="text-amber-400">keepalive</span>(),                  <span class="text-dimmed">// notice a dead socket fast</span>
  <span class="text-amber-400">buffering</span>({ enabled: <span class="text-violet-400">true</span> }),  <span class="text-dimmed">// keep offline sends</span>
  <span class="text-amber-400">dedup</span>(),                      <span class="text-dimmed">// no duplicates on catch-up</span>
  <span class="text-amber-400">replay</span>(),                     <span class="text-dimmed">// fill in what you missed</span>
)</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width wire: messages flow, pause on drop, replay on reconnect, dedup the double -->
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
          <span class="font-mono text-xs sm:text-sm text-toned">live socket · messages keep flowing through a disconnect</span>
          <span class="ml-auto inline-flex items-center justify-end gap-1.5 min-w-[8.5rem] font-mono text-[11px] transition-colors duration-300" :class="toneText[status.tone]">
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

        <div class="grid grid-cols-[minmax(0,1fr)_1.6fr_minmax(0,1fr)] items-stretch">
          <!-- Client (left): receives, in order, no doubles -->
          <div class="px-4 py-5 sm:px-5">
            <div class="flex items-center gap-2 mb-3">
              <UIcon name="i-ph-laptop-duotone" class="size-5 text-sky-300" />
              <span class="font-mono text-sm text-toned">client</span>
              <span class="ml-auto font-mono text-[10px] tracking-wide uppercase text-dimmed">received</span>
            </div>
            <div class="space-y-2 h-44 overflow-hidden">
              <div
                v-for="m in receivedMsgs"
                :key="`r-${m.seq}-${m.lane}`"
                class="flex items-center gap-2.5 border border-emerald-400/45 bg-emerald-500/[0.08] px-3 py-2 font-mono text-xs sm:text-[13px] leading-4"
              >
                <UIcon name="i-ph-check-duotone" class="size-3.5 text-emerald-300 shrink-0" />
                <span class="text-violet-300 tabular-nums">#{{ m.seq }}</span>
                <span class="text-toned truncate">order-update</span>
              </div>
            </div>
          </div>

          <!-- The wire: messages fly right → left; breaks on drop -->
          <div class="relative px-1 py-5 bg-elevated/20 overflow-hidden">
            <!-- the rail -->
            <div class="absolute inset-x-4 top-1/2 -translate-y-1/2 h-px transition-colors duration-300" :class="broken ? 'bg-red-500/30' : 'bg-emerald-500/30'" />
            <!-- broken marker -->
            <div
              class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] whitespace-nowrap transition-all duration-300"
              :class="broken ? 'opacity-100 border-red-500/50 bg-red-500/10 text-red-300' : 'opacity-0'"
            >
              <UIcon name="i-ph-plugs-duotone" class="size-3.5" /> disconnected
            </div>
            <!-- the message chips -->
            <div
              v-for="(m, i) in messages"
              :key="`m-${i}`"
              class="msg absolute z-10 -translate-y-1/2 flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] whitespace-nowrap rounded-sm"
              :class="[
                mstate[i] === 'dropped'
                  ? 'border-red-400/60 bg-red-500/15 text-red-200 shadow-[0_0_14px] shadow-red-500/40'
                  : 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_14px] shadow-emerald-500/40',
                onWire(i) ? 'opacity-100' : 'opacity-0',
              ]"
              :style="{ top: `${24 + m.lane * 26}%`, left: chipLeft(i) }"
            >
              <UIcon :name="mstate[i] === 'dropped' ? 'i-ph-x-circle-duotone' : 'i-ph-arrow-left-duotone'" class="size-3.5" />
              <span class="tabular-nums">#{{ m.seq }}</span>
              <span>{{ mstate[i] === 'dropped' ? 'deduped' : 'order-update' }}</span>
            </div>
          </div>

          <!-- Server (right): the source; holds messages it can't send -->
          <div class="px-4 py-5 sm:px-5 border-l border-muted/50">
            <div class="flex items-center gap-2 mb-3">
              <span class="font-mono text-sm text-toned">server</span>
              <UIcon name="i-ph-hard-drives-duotone" class="size-5 text-emerald-300" />
              <span class="ml-auto font-mono text-[10px] tracking-wide uppercase transition-colors duration-300" :class="heldMsgs.length ? 'text-amber-300' : 'text-dimmed'">
                {{ heldMsgs.length ? 'held' : 'emitting' }}
              </span>
            </div>
            <div class="space-y-2 h-44 overflow-hidden">
              <div
                v-for="m in heldMsgs"
                :key="`h-${m.seq}`"
                class="flex items-center gap-2.5 border border-amber-400/45 bg-amber-500/[0.07] px-3 py-2 font-mono text-xs sm:text-[13px] leading-4"
              >
                <UIcon name="i-ph-clock-duotone" class="size-3.5 text-amber-300 shrink-0" />
                <span class="text-violet-300 tabular-nums">#{{ m.seq }}</span>
                <span class="text-toned truncate">order-update</span>
                <span class="ml-auto text-[10px] text-amber-300">held</span>
              </div>
              <p v-if="!heldMsgs.length" class="font-mono text-[11px] text-dimmed pt-1">
                {{ phase === 'synced' ? 'all delivered · in order' : 'streaming in order →' }}
              </p>
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-shield-check-duotone" class="size-4 text-emerald-400 shrink-0" />
          messages flow until the socket disconnects, hold while it's down, then replay on reconnect — and the duplicate never lands twice
        </div>
      </div>
    </Motion>
  </section>
</template>

<style scoped>
.msg {
  transition-property: left, opacity;
  transition-duration: 750ms, 250ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1), ease;
}
</style>
