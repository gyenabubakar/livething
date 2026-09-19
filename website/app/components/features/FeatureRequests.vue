<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const prefersReducedMotion = ref(false)

const pills = [
  { label: 'Awaited responses', icon: 'i-ph-arrows-clockwise-duotone' },
  { label: 'Auto-correlated', icon: 'i-ph-link-duotone' },
  { label: 'Multiplexed', icon: 'i-ph-stack-duotone' },
]

/* ----------------------------------------------------------------------------
 * Main wire: color-tagged parcels share one socket. Each reply comes home in
 * the same colour as its call — even when the server answers out of order.
 * ------------------------------------------------------------------------- */

type Leg = 'idle' | 'queued' | 'outbound' | 'serving' | 'inbound' | 'resolved'
const RANK: Record<Leg, number> = {
  idle: 0, queued: 1, outbound: 2, serving: 3, inbound: 4, resolved: 5,
}

interface Parcel {
  event: string
  payload: string
  result: string
  hue: string // tailwind colour stem, e.g. 'sky'
}

const parcels: Parcel[] = [
  { event: 'get-user', payload: "{ id: 'u_42' }", result: '{ name: "Ada" }', hue: 'sky' },
  { event: 'list-orders', payload: "{ since: 'May' }", result: '{ count: 3 }', hue: 'violet' },
  { event: 'search', payload: "{ q: 'ws' }", result: '{ hits: 12 }', hue: 'emerald' },
  { event: 'get-prefs', payload: "{ id: 'u_42' }", result: '{ theme: "dark" }', hue: 'amber' },
]

const legs = ref<Leg[]>(parcels.map(() => 'idle'))

function setLeg(i: number, l: Leg) {
  const next = [...legs.value]
  next[i] = l
  legs.value = next
}
function resetMain() {
  legs.value = parcels.map(() => 'idle')
}

// Calls go out A,B,C,D; replies come home out of order: C, A, D, B.
const TRAVEL = 1300
const mainEvents: TimedEvent[] = [
  { at: 300, run: () => setLeg(0, 'queued') },
  { at: 650, run: () => setLeg(1, 'queued') },
  { at: 1000, run: () => setLeg(2, 'queued') },
  { at: 1350, run: () => setLeg(3, 'queued') },
  // outbound
  { at: 1700, run: () => setLeg(0, 'outbound') },
  { at: 1950, run: () => setLeg(1, 'outbound') },
  { at: 2200, run: () => setLeg(2, 'outbound') },
  { at: 2450, run: () => setLeg(3, 'outbound') },
  // arrive at server (outbound + TRAVEL)
  { at: 3000, run: () => setLeg(0, 'serving') },
  { at: 3250, run: () => setLeg(1, 'serving') },
  { at: 3500, run: () => setLeg(2, 'serving') },
  { at: 3750, run: () => setLeg(3, 'serving') },
  // reply, out of order: C, A, D, B
  { at: 4100, run: () => setLeg(2, 'inbound') },
  { at: 4500, run: () => setLeg(0, 'inbound') },
  { at: 4900, run: () => setLeg(3, 'inbound') },
  { at: 5300, run: () => setLeg(1, 'inbound') },
  // resolved on the client (inbound + TRAVEL)
  { at: 5400, run: () => setLeg(2, 'resolved') },
  { at: 5800, run: () => setLeg(0, 'resolved') },
  { at: 6200, run: () => setLeg(3, 'resolved') },
  { at: 6600, run: () => setLeg(1, 'resolved') },
]
const mainTotal = 6600 + 2600

const main = useTimedSequence({ events: mainEvents, totalDuration: mainTotal, loop: true, onReset: resetMain })

/* ----------------------------------------------------------------------------
 * Subsection: the server asks THIS client and waits — a parcel that starts on
 * the right (server) and flies left to the client, whose answer flies back.
 * ------------------------------------------------------------------------- */

type Ask = 'idle' | 'ask' | 'atClient' | 'answer' | 'done'
const ask = ref<Ask>('idle')
const ASKRANK: Record<Ask, number> = { idle: 0, ask: 1, atClient: 2, answer: 3, done: 4 }

function resetAsk() { ask.value = 'idle' }
const askEvents: TimedEvent[] = [
  { at: 600, run: () => { ask.value = 'ask' } },
  { at: 1900, run: () => { ask.value = 'atClient' } },
  { at: 3200, run: () => { ask.value = 'answer' } },
  { at: 4500, run: () => { ask.value = 'done' } },
]
const askSeq = useTimedSequence({ events: askEvents, totalDuration: 4500 + 2600, loop: true, onReset: resetAsk })

/* ------------------------------------------------------------------------- */

const wireRef = ref<HTMLElement>()
const askRef = ref<HTMLElement>()

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) {
    legs.value = parcels.map(() => 'resolved')
    ask.value = 'done'
  }
})

useViewportActivation(wireRef, {
  threshold: 0.2,
  disabled: prefersReducedMotion,
  onEnter: () => {
    main.start()
    main.resume()
  },
  onExit: main.pause,
})

useViewportActivation(askRef, {
  threshold: 0.2,
  disabled: prefersReducedMotion,
  onEnter: () => {
    askSeq.start()
    askSeq.resume()
  },
  onExit: askSeq.pause,
})

// Parcel position. At the server it is right-anchored (left:100% +
// translateX(-100%)) so its right edge meets the server side — mirroring the
// client side, where left:0 meets the client edge.
function parcelAtServer(i: number): boolean {
  const l = legs.value[i] ?? 'idle'
  return l === 'outbound' || l === 'serving'
}
function parcelStyle(i: number): Record<string, string> {
  const atServer = parcelAtServer(i)
  return {
    top: `${20 + i * 20}%`,
    left: atServer ? '100%' : '0%',
    transform: atServer ? 'translateX(-100%)' : 'translateX(0)',
  }
}
function parcelOn(i: number): boolean {
  const l = legs.value[i] ?? 'idle'
  return l === 'outbound' || l === 'serving' || l === 'inbound'
}
function parcelReturning(i: number): boolean {
  // inbound OR resolved — so the arrow/result stays "homeward" through the fade-out
  return RANK[legs.value[i] ?? 'idle'] >= RANK.inbound
}
function clientDone(i: number): boolean {
  return legs.value[i] === 'resolved'
}
function clientPending(i: number): boolean {
  const r = RANK[legs.value[i] ?? 'idle']
  return r >= RANK.queued && r < RANK.resolved
}
function serverActive(i: number): boolean {
  return RANK[legs.value[i] ?? 'idle'] >= RANK.serving
}

// Static colour maps (full class strings so Tailwind keeps them).
const dotBg: Record<string, string> = { sky: 'bg-sky-400', violet: 'bg-violet-400', emerald: 'bg-emerald-400', amber: 'bg-amber-400' }
const txt: Record<string, string> = { sky: 'text-sky-300', violet: 'text-violet-300', emerald: 'text-emerald-300', amber: 'text-amber-300' }
const parcelCls: Record<string, string> = {
  sky: 'border-sky-400/60 bg-sky-500/15 text-sky-200 shadow-[0_0_16px] shadow-sky-500/40',
  violet: 'border-violet-400/60 bg-violet-500/15 text-violet-200 shadow-[0_0_16px] shadow-violet-500/40',
  emerald: 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_16px] shadow-emerald-500/40',
  amber: 'border-amber-400/60 bg-amber-500/15 text-amber-200 shadow-[0_0_16px] shadow-amber-500/40',
}
</script>

<template>
  <section class="deferred-section py-24 md:py-32">
    <!-- Top: copy on the left, code on the right -->
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
          <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-toned [&_code]:font-mono [&_code]:text-primary [&_code]:bg-elevated/60 [&_code]:px-1">
            <slot name="description" mdc-unwrap="p" />
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <span
              v-for="pill in pills"
              :key="pill.label"
              class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-xs text-toned"
            >
              <UIcon :name="pill.icon" class="size-3.5 text-emerald-400" />
              {{ pill.label }}
            </span>
          </div>
          <NuxtLink v-if="props.link" :to="props.link" class="mt-5 group inline-flex items-center gap-1.5 font-mono text-xs text-primary transition-colors">
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
        class="flex flex-col justify-center gap-4 h-full"
      >
        <div class="overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
              <span class="size-1.5 rounded-full bg-sky-400" /> client
            </span>
            <span class="font-mono text-xs text-toned">app.client.ts</span>
          </div>
          <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="block"><span class="text-dimmed">// ask, await the typed answer</span></span><span class="block -mx-5 border-l-2 border-sky-500/70 bg-sky-500/10 pl-[calc(1.25rem-2px)] pr-5"><span class="text-violet-400">const</span> user = <span class="text-violet-400">await</span> socket.<span class="text-amber-400">request</span>(<span class="text-emerald-400">'get-user'</span>, { id })</span><span class="block"><span class="text-dimmed">//    user: { name: string; email: string }</span></span></code></pre>
          </div>
        </div>

        <div class="overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">api.server.ts</span>
          </div>
          <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="block"><span class="text-violet-400">const</span> getUser = base.<span class="text-amber-400">request</span>(<span class="text-emerald-400">'get-user'</span>, {</span><span class="block">  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ id: v.<span class="text-amber-400">string</span>() }),</span><span class="block">  <span class="text-sky-400">run</span>(ctx, { id }) {</span><span class="block -mx-5 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.25rem-2px)] pr-5">    <span class="text-violet-400">return</span> db.users.<span class="text-amber-400">find</span>(id) <span class="text-dimmed">// typed reply</span></span><span class="block">  },</span><span class="block">})</span></code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width living wire: parcels share one socket, colour = conversation -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10"
    >
      <div ref="wireRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-arrows-left-right-duotone" class="size-4 text-primary" />
          <span class="font-mono text-xs sm:text-sm text-toned">one socket · four requests in flight</span>
          <span class="hidden sm:inline font-mono text-xs text-primary tracking-wide">colour = conversation</span>
          <div class="ml-auto flex items-center gap-1">
            <button
              type="button"
              class="size-7 inline-flex items-center justify-center text-toned hover:text-default focus:text-default focus:outline-none transition-colors"
              :aria-label="main.paused.value ? 'Play animation' : 'Pause animation'"
              :disabled="!main.started.value"
              @click="main.toggle"
            >
              <UIcon :name="main.paused.value ? 'i-ph-play-duotone' : 'i-ph-pause-duotone'" class="size-3.5" />
            </button>
            <button
              type="button"
              class="size-7 inline-flex items-center justify-center text-toned hover:text-default focus:text-default focus:outline-none transition-colors"
              aria-label="Restart animation"
              :disabled="!main.started.value"
              @click="main.restart"
            >
              <UIcon name="i-ph-arrow-counter-clockwise-duotone" class="size-3.5" />
            </button>
          </div>
        </div>

        <div class="grid grid-cols-[minmax(0,0.9fr)_1.6fr_minmax(0,0.9fr)] items-stretch">
          <!-- Client -->
          <div class="px-4 py-5 sm:px-5">
            <div class="flex items-center gap-2 mb-4">
              <UIcon name="i-ph-laptop-duotone" class="size-5 text-sky-300" />
              <span class="font-mono text-sm text-toned">client</span>
            </div>
            <div class="space-y-2.5">
              <div
                v-for="(p, i) in parcels"
                :key="p.event"
                class="flex items-center gap-2.5 border px-3 py-2 font-mono text-xs sm:text-[13px] leading-4 transition-colors duration-300"
                :class="clientDone(i)
                  ? 'border-emerald-400/50 bg-emerald-500/10'
                  : (clientPending(i) ? 'border-muted bg-elevated/30' : 'border-muted/40 opacity-50')"
              >
                <span class="size-2 shrink-0 rounded-full" :class="dotBg[p.hue]" />
                <span class="text-toned truncate">{{ p.event }}</span>
                <span class="ml-auto flex size-4 shrink-0 items-center justify-center">
                  <UIcon v-if="clientDone(i)" name="i-ph-check-circle-duotone" class="size-4 text-emerald-300" />
                  <UIcon v-else-if="clientPending(i)" name="i-ph-circle-notch-duotone" class="size-4 text-amber-300 animate-spin" />
                </span>
              </div>
            </div>
            <p class="mt-4 font-mono text-xs text-toned">await socket.request(…)</p>
          </div>

          <!-- The pipe -->
          <div class="relative self-stretch py-5">
            <div class="wire-pipe absolute inset-x-0 top-1/2 -translate-y-1/2 h-[72%] rounded-sm border-y border-primary/20 bg-primary/[0.03]" />
            <div
              v-for="(p, i) in parcels"
              :key="`p-${p.event}`"
              class="parcel absolute z-10 -translate-y-1/2 flex items-center gap-2 border px-2.5 py-1 font-mono text-xs whitespace-nowrap rounded-sm"
              :class="[
                parcelCls[p.hue],
                parcelOn(i) ? 'opacity-100' : 'opacity-0',
                legs[i] === 'serving' ? 'scale-105' : 'scale-100',
              ]"
              :style="parcelStyle(i)"
            >
              <UIcon :name="parcelReturning(i) ? 'i-ph-arrow-left-duotone' : 'i-ph-arrow-right-duotone'" class="size-3.5" />
              <span>{{ parcelReturning(i) ? p.result : p.payload }}</span>
            </div>
          </div>

          <!-- Server -->
          <div class="px-4 py-5 sm:px-5">
            <div class="flex items-center justify-end gap-2 mb-4">
              <span class="font-mono text-sm text-toned">server</span>
              <UIcon name="i-ph-hard-drives-duotone" class="size-5 text-emerald-300" />
            </div>
            <div class="space-y-2.5">
              <div
                v-for="(p, i) in parcels"
                :key="`s-${p.event}`"
                class="flex items-center gap-2.5 border px-3 py-2 font-mono text-xs sm:text-[13px] leading-4 transition-colors duration-300"
                :class="serverActive(i) ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-muted/40 opacity-50'"
              >
                <span class="text-violet-300 shrink-0">run</span>
                <span class="text-toned truncate">{{ p.event }}</span>
                <span class="ml-auto shrink-0 transition-opacity duration-300" :class="serverActive(i) ? 'opacity-100 text-emerald-300' : 'opacity-0'">{{ p.result }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-link-duotone" class="size-4 text-primary shrink-0" />
          replies can land in any order — LiveThing routes each one back to the <span class="text-primary">promise that asked</span>. No manual IDs, no bookkeeping.
        </div>
      </div>
    </Motion>

    <!-- Subsection: server-sent requests -->
    <div class="mt-20 md:mt-24">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
        class="mb-8"
      >
        <div>
          <p class="section-label">Server-sent requests</p>
          <h3 class="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-highlighted">
            The server can ask too<span class="text-primary">.</span>
          </h3>
          <p class="mt-5 max-w-xl text-sm leading-relaxed text-toned">
            Requests usually go one way — the client asks, the server answers. LiveThing lets the server turn around and ask the client — for a confirmation, a permission, a value — and <code class="font-mono text-primary bg-elevated/60 border border-muted px-1 py-0.5">await</code> the typed answer, with a timeout if it never comes. The same request/response, pointed the other direction.
          </p>
        </div>
      </Motion>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.1 }"
        :in-view-options="{ once: true }"
        class="grid gap-6 lg:grid-cols-2 *:min-w-0 items-stretch"
      >
          <div class="h-full overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
              <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
                <span class="size-1.5 rounded-full bg-emerald-400" /> server
              </span>
              <span class="font-mono text-xs text-toned">permission.server.ts</span>
            </div>
            <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
              <pre><code><span class="block"><span class="text-dimmed">// 'ask-permission' is declared in the requests() capability,</span></span><span class="block"><span class="text-dimmed">// with an out the server sends and an in the client returns.</span></span><span class="block"><span class="text-dimmed">// ask this client, then await its typed answer:</span></span><span class="block -mx-5 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.25rem-2px)] pr-5"><span class="text-violet-400">const</span> { allowed } = <span class="text-violet-400">await</span> ctx.<span class="text-amber-400">request</span>(<span class="text-emerald-400">'ask-permission'</span>, { action })</span></code></pre>
            </div>
          </div>

          <div class="h-full overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
              <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
                <span class="size-1.5 rounded-full bg-sky-400" /> client
              </span>
              <span class="font-mono text-xs text-toned">permission.client.ts</span>
            </div>
            <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
              <pre><code><span class="block"><span class="text-dimmed">// answer the server's request</span></span><span class="block -mx-5 border-l-2 border-sky-500/70 bg-sky-500/10 pl-[calc(1.25rem-2px)] pr-5">socket.<span class="text-amber-400">onRequest</span>(<span class="text-emerald-400">'ask-permission'</span>, ({ action }) => {
  <span class="text-violet-400">return</span> { allowed: window.<span class="text-amber-400">confirm</span>(action) }
})</span></code></pre>
            </div>
          </div>
        </Motion>

        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.2 }"
          :in-view-options="{ once: true }"
          class="mt-6 block"
        >
          <div ref="askRef" class="overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
              <span class="font-mono text-xs sm:text-sm text-toned">server asks · client answers</span>
              <span
                class="ml-auto font-mono text-xs tracking-wide transition-colors duration-300"
                :class="ask === 'done' ? 'text-emerald-300' : ask === 'idle' ? 'text-toned' : 'text-amber-300'"
              >
                {{ ask === 'idle' ? 'idle' : ask === 'ask' ? 'asking' : ask === 'atClient' ? 'awaiting' : ask === 'answer' ? 'answering' : 'resolved' }}
              </span>
            </div>

            <div class="relative px-4 py-6">
              <div class="grid grid-cols-[minmax(0,1fr)_1.4fr_minmax(0,1fr)] items-center gap-2">
                <!-- server (left) — it initiates the ask -->
                <div
                  class="border px-3 py-3 transition-all duration-300"
                  :class="ask === 'done' ? 'border-emerald-400/50 bg-emerald-500/10' : (ask !== 'idle' ? 'border-emerald-400/30 bg-emerald-500/[0.04]' : 'border-muted/40 opacity-50')"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-ph-hard-drives-duotone" class="size-4 text-emerald-300 shrink-0" />
                    <span class="font-mono text-xs text-toned">server</span>
                  </div>
                  <div class="mt-2 font-mono text-[11px] text-toned">ctx.request</div>
                  <div
                    class="mt-2 flex items-center gap-1.5 font-mono text-[11px] transition-colors duration-300"
                    :class="ask === 'done' ? 'text-emerald-300' : 'text-toned'"
                  >
                    <UIcon :name="ask === 'done' ? 'i-ph-check-circle-duotone' : 'i-ph-circle-notch-duotone'" class="size-3.5" :class="ask !== 'done' && ask !== 'idle' ? 'animate-spin' : ''" />
                    await
                  </div>
                </div>

                <!-- the wire: ask flies right (server → client), answer flies left back -->
                <div class="relative h-20">
                  <div class="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-muted/50" />
                  <div
                    class="parcel absolute top-1/2 -translate-y-1/2 flex items-center gap-1.5 border border-amber-400/60 bg-amber-500/15 text-amber-200 shadow-[0_0_14px] shadow-amber-500/40 px-2 py-1 font-mono text-[11px] whitespace-nowrap"
                    :class="ask === 'ask' || ask === 'atClient' ? 'opacity-100' : 'opacity-0'"
                    :style="{ left: (ask === 'ask' || ask === 'atClient') ? '100%' : '0%', transform: (ask === 'ask' || ask === 'atClient') ? 'translateX(-100%)' : 'translateX(0)' }"
                  >
                    ask-permission <UIcon name="i-ph-arrow-right-duotone" class="size-3.5" />
                  </div>
                  <div
                    class="parcel absolute top-1/2 -translate-y-1/2 flex items-center gap-1.5 border border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_14px] shadow-emerald-500/40 px-2 py-1 font-mono text-[11px] whitespace-nowrap"
                    :class="ask === 'answer' || ask === 'done' ? 'opacity-100' : 'opacity-0'"
                    :style="{ left: (ask === 'answer' || ask === 'done') ? '0%' : '100%', transform: (ask === 'answer' || ask === 'done') ? 'translateX(0)' : 'translateX(-100%)' }"
                  >
                    <UIcon name="i-ph-arrow-left-duotone" class="size-3.5" /> { allowed: true }
                  </div>
                </div>

                <!-- client (right) — it answers -->
                <div
                  class="border px-3 py-3 transition-all duration-300"
                  :class="ASKRANK[ask] >= ASKRANK.atClient && ask !== 'done' ? 'border-sky-400/50 bg-sky-500/10' : (ask === 'done' ? 'border-muted bg-elevated/20' : 'border-muted/40 opacity-50')"
                >
                  <div class="flex items-center justify-end gap-2">
                    <span class="font-mono text-xs text-toned">client</span>
                    <UIcon name="i-ph-laptop-duotone" class="size-4 text-sky-300 shrink-0" />
                  </div>
                  <div class="mt-2 text-right font-mono text-[11px] text-toned">onRequest</div>
                  <div
                    class="mt-2 flex items-center justify-end gap-1.5 border border-emerald-400/50 px-2 py-1 font-mono text-[11px] text-emerald-300 transition-all duration-300"
                    :class="ASKRANK[ask] >= ASKRANK.answer ? 'bg-emerald-500/15 opacity-100' : 'opacity-40'"
                  >
                    <UIcon name="i-ph-check-duotone" class="size-3.5" /> allow “delete”
                  </div>
                </div>
              </div>

              <p class="mt-6 text-center font-mono text-xs text-toned">
                server asks the client and <span class="text-toned">awaits</span> its typed answer
              </p>
            </div>
          </div>
        </Motion>
    </div>
  </section>
</template>

<style scoped>
.parcel {
  transition-property: left, transform, scale, opacity;
  transition-duration: 1300ms, 1300ms, 250ms, 250ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}

.wire-pipe {
  background-image: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-color-primary-500) 8%, transparent) 0%,
    transparent 50%,
    color-mix(in srgb, var(--ui-color-primary-500) 8%, transparent) 100%
  );
}
</style>
