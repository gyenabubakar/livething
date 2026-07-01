<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const prefersReducedMotion = ref(false)
const demoRef = ref<HTMLElement>()
const nudgeRef = ref<HTMLElement>()

// main token-stream demo
const shown = ref(0)
const phase = ref<'streaming' | 'done'>('streaming')
// nudges demo
const stepShown = ref(0)

let tickInterval: ReturnType<typeof setInterval> | undefined
let restartTimer: ReturnType<typeof setTimeout> | undefined
let stepInterval: ReturnType<typeof setInterval> | undefined
let stepRestart: ReturnType<typeof setTimeout> | undefined

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Async generators', icon: 'i-ph-waveform-duotone' },
  { label: 'Steerable nudges', icon: 'i-ph-sliders-horizontal-duotone' },
  { label: 'Durable resume', icon: 'i-ph-arrow-clockwise-duotone' },
]

// The AI reply that streams in, one token per chunk.
const tokens = ['WSKit ', 'gives ', 'your ', 'server ', 'and ', 'client ', 'one ', 'inferred ', 'contract, ', 'so ', 'realtime ', 'stays ', 'type-safe ', 'end ', 'to ', 'end. ', 'Each ', 'yield ', 'is ', 'one ', 'typed ', 'chunk ', 'on ', 'the ', 'wire, ', 'and ', 'the ', 'client ', 'reads ', 'them ', 'with ', 'a ', 'plain ', 'for-await ', 'loop ', 'as ', 'they ', 'arrive.']
const visibleText = computed(() => tokens.slice(0, shown.value).join(''))

// One chunk per agent step; the redirect nudge is read between two of them.
const agentSteps = [
  { kind: 'step', tool: 'plan', detail: 'break down the task' },
  { kind: 'step', tool: 'search', detail: 'find the changelog' },
  { kind: 'nudge', tool: 'redirect', detail: '"use the v2 API"' },
  { kind: 'step', tool: 'search', detail: 'query the v2 API' },
  { kind: 'step', tool: 'answer', detail: 'drafted from v2' },
] as const

function tick() {
  if (shown.value < tokens.length) {
    shown.value++
    if (shown.value === tokens.length) {
      phase.value = 'done'
      restartTimer = setTimeout(() => {
        shown.value = 0
        phase.value = 'streaming'
      }, 2400)
    }
  }
}

function stepTick() {
  if (stepShown.value < agentSteps.length) {
    stepShown.value++
    if (stepShown.value === agentSteps.length) {
      stepRestart = setTimeout(() => {
        stepShown.value = 0
      }, 2600)
    }
  }
}

/* ----------------------------------------------------------------------------
 * Durable streams — two demos.
 * Recorded (good for AI): buffers every chunk; a reconnecting client replays
 * the misses. Resumable (good for deterministic sources): stores only a cursor
 * and re-runs the generator from it.
 * ------------------------------------------------------------------------- */
const recordedRef = ref<HTMLElement>()
const resumableRef = ref<HTMLElement>()

// Recorded: AI tokens stream, the socket drops, the missed chunks replay.
const recTokens = ['Type-', 'safe ', 'realtime, ', 'token ', 'by ', 'token']
type RecS = 'idle' | 'live' | 'buffered' | 'replayed'
const recState = ref<RecS[]>(recTokens.map(() => 'idle'))
type RecPhase = 'streaming' | 'dropped' | 'replaying' | 'synced'
const recPhase = ref<RecPhase>('streaming')
function recSet(i: number, s: RecS) {
  const next = [...recState.value]
  next[i] = s
  recState.value = next
}
function recReset() {
  recPhase.value = 'streaming'
  recState.value = recTokens.map(() => 'idle')
}
const recEvents: TimedEvent[] = [
  { at: 300, run: () => recSet(0, 'live') },
  { at: 750, run: () => recSet(1, 'live') },
  { at: 1200, run: () => recSet(2, 'live') },
  { at: 1700, run: () => { recPhase.value = 'dropped' } },
  { at: 2050, run: () => recSet(3, 'buffered') },
  { at: 2450, run: () => recSet(4, 'buffered') },
  { at: 3500, run: () => { recPhase.value = 'replaying' } },
  { at: 3850, run: () => recSet(3, 'replayed') },
  { at: 4200, run: () => recSet(4, 'replayed') },
  { at: 4650, run: () => recSet(5, 'live') },
  { at: 5050, run: () => { recPhase.value = 'synced' } },
]
const recSeq = useTimedSequence({ events: recEvents, totalDuration: 5050 + 2400, loop: true, onReset: recReset })
const recStatus = computed(() => {
  switch (recPhase.value) {
    case 'dropped': return { label: 'disconnected', tone: 'bad' }
    case 'replaying': return { label: 'replaying buffer', tone: 'warn' }
    case 'synced': return { label: 'in sync', tone: 'ok' }
    default: return { label: 'streaming', tone: 'warn' }
  }
})

// Resumable: rows are produced and the cursor advances; on reconnect the
// generator re-runs from the saved cursor and continues live.
const resRows = [1, 2, 3, 4, 5, 6]
const resShown = ref(0)
const resCursor = ref(0)
type ResPhase = 'streaming' | 'dropped' | 'rerun' | 'synced'
const resPhase = ref<ResPhase>('streaming')
function resReset() {
  resPhase.value = 'streaming'
  resShown.value = 0
  resCursor.value = 0
}
const resEvents: TimedEvent[] = [
  { at: 300, run: () => { resShown.value = 1; resCursor.value = 1 } },
  { at: 750, run: () => { resShown.value = 2; resCursor.value = 2 } },
  { at: 1200, run: () => { resShown.value = 3; resCursor.value = 3 } },
  { at: 1700, run: () => { resPhase.value = 'dropped' } },
  { at: 3100, run: () => { resPhase.value = 'rerun' } },
  { at: 3650, run: () => { resShown.value = 4; resCursor.value = 4 } },
  { at: 4100, run: () => { resShown.value = 5; resCursor.value = 5 } },
  { at: 4550, run: () => { resShown.value = 6; resCursor.value = 6 } },
  { at: 5000, run: () => { resPhase.value = 'synced' } },
]
const resSeq = useTimedSequence({ events: resEvents, totalDuration: 5000 + 2400, loop: true, onReset: resReset })
const resStatus = computed(() => {
  switch (resPhase.value) {
    case 'dropped': return { label: 'disconnected', tone: 'bad' }
    case 'rerun': return { label: 're-running from cursor', tone: 'warn' }
    case 'synced': return { label: 'in sync', tone: 'ok' }
    default: return { label: 'streaming', tone: 'warn' }
  }
})

const durableTone: Record<string, string> = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-red-300' }
const durableDot: Record<string, string> = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-red-400' }

function startTick() {
  if (tickInterval) return
  if (phase.value === 'done') {
    shown.value = 0
    phase.value = 'streaming'
  }
  tickInterval = setInterval(tick, 150)
}

function stopTick() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = undefined
  }
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = undefined
  }
}

function startStep() {
  if (stepInterval) return
  if (stepShown.value === agentSteps.length) stepShown.value = 0
  stepInterval = setInterval(stepTick, 950)
}

function stopStep() {
  if (stepInterval) {
    clearInterval(stepInterval)
    stepInterval = undefined
  }
  if (stepRestart) {
    clearTimeout(stepRestart)
    stepRestart = undefined
  }
}

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) {
    shown.value = tokens.length
    phase.value = 'done'
    stepShown.value = agentSteps.length
    recState.value = recTokens.map(() => 'live')
    recPhase.value = 'synced'
    resShown.value = resRows.length
    resCursor.value = resRows.length
    resPhase.value = 'synced'
  }
})

useViewportActivation(demoRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: startTick,
  onExit: stopTick,
})

useViewportActivation(nudgeRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: startStep,
  onExit: stopStep,
})

useViewportActivation(recordedRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: () => {
    recSeq.start()
    recSeq.resume()
  },
  onExit: recSeq.pause,
})

useViewportActivation(resumableRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: () => {
    resSeq.start()
    resSeq.resume()
  },
  onExit: resSeq.pause,
})

onBeforeUnmount(() => {
  stopTick()
  stopStep()
})
</script>

<template>
  <section class="deferred-section pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + server generator code -->
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
              class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-toned"
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
        class="h-full"
      >
        <div class="h-full flex flex-col overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">ai.server.ts</span>
          </div>
          <div class="flex-1 flex flex-col justify-center p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">export const</span> handleAsk = base.<span class="text-amber-400">stream</span>(<span class="text-emerald-400">'ask-ai'</span>, {
  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ prompt: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">chunk</span>: <span class="text-amber-400">t</span>&lt;{ token: <span class="text-sky-400">string</span> }&gt;(),
  <span class="text-violet-400">async</span> *<span class="text-sky-400">run</span>(ctx, { prompt }) {
    <span class="text-violet-400">for await</span> (<span class="text-violet-400">const</span> token <span class="text-violet-400">of</span> <span class="text-amber-400">llm</span>(prompt)) {
      <span class="text-violet-400">yield</span> { token } <span class="text-dimmed">// one chunk on the wire</span>
    }
  },
})</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width wire: the server yields chunks that flow to the client and assemble -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="demoRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-waveform-duotone" class="size-4 text-primary" />
          <span class="font-mono text-xs sm:text-sm text-toned">stream: ask-ai · one chunk at a time</span>
          <span
            class="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] transition-colors duration-300"
            :class="phase === 'done' ? 'text-emerald-300' : 'text-amber-300'"
          >
            <span class="size-1.5 rounded-full" :class="phase === 'done' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'" />
            {{ phase === 'done' ? 'complete' : 'streaming' }}
          </span>
        </div>

        <div class="grid grid-cols-[auto_1fr_minmax(0,1.4fr)] items-stretch">
          <!-- server: the generator -->
          <div class="flex items-center px-4 py-6 sm:px-6">
            <div
              class="border px-4 py-3 transition-colors duration-300"
              :class="phase === 'streaming' ? 'border-amber-400/40 bg-amber-500/[0.06]' : 'border-muted bg-elevated/20'"
            >
              <div class="flex items-center gap-2">
                <UIcon name="i-ph-hard-drives-duotone" class="size-4 text-amber-300 shrink-0" />
                <span class="font-mono text-xs text-toned">server</span>
              </div>
              <div class="mt-2 font-mono text-[11px] text-toned">async *run</div>
              <div class="mt-1 font-mono text-[11px]">
                <span class="text-violet-300">yield</span> <span class="text-muted">{ token }</span>
              </div>
            </div>
          </div>

          <!-- the wire: chunks flowing left → right -->
          <div class="relative flex items-center px-1">
            <div class="relative h-px w-full bg-muted/40">
              <div
                class="flow-wire absolute inset-0 -top-px h-0.5"
                :class="phase === 'streaming' ? 'opacity-100' : 'opacity-0'"
              />
            </div>
            <UIcon name="i-ph-caret-right-duotone" class="absolute right-0 size-4 text-primary/60" />
          </div>

          <!-- client: chunks assembling -->
          <div class="px-4 py-6 sm:px-6 border-l border-muted/50">
            <div class="flex items-center gap-2 mb-3">
              <UIcon name="i-ph-laptop-duotone" class="size-4 text-sky-300 shrink-0" />
              <span class="font-mono text-xs text-toned">client</span>
              <span class="ml-auto font-mono text-[11px] text-toned">for await</span>
            </div>
            <div class="min-h-[5rem] border-l-2 border-amber-500/30 pl-3 font-mono text-xs sm:text-sm leading-relaxed text-toned">
              {{ visibleText }}<span
                v-if="phase === 'streaming'"
                v-play-when-visible
                class="inline-block w-1.5 h-3.5 -mb-0.5 bg-amber-400 animate-pulse"
              />
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 flex items-center justify-between font-mono text-xs text-toned">
          <span><span class="text-amber-300">←</span> chunk <span class="text-muted">{ token }</span> — read with a <span class="text-toned">for await</span> loop</span>
          <span class="tabular-nums">{{ shown }} / {{ tokens.length }} received</span>
        </div>
      </div>
    </Motion>

    <!-- Sub-section: nudges -->
    <div class="mt-20 md:mt-24">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
        class="mb-8"
      >
        <div>
          <p class="section-label">Nudges</p>
          <h3 class="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-highlighted">
            Steer it between steps<span class="text-primary">.</span>
          </h3>
          <p class="mt-5 max-w-xl text-sm leading-relaxed text-toned">
            Change your mind mid-stream. Between steps, the client can reach back into a running stream to <code class="font-mono text-primary bg-elevated/60 border border-muted px-1 py-0.5">stop</code> it or point it somewhere new, with no restart and nothing torn down. Typed, like everything else.
          </p>
        </div>
      </Motion>

      <div class="grid gap-6 lg:grid-cols-2 *:min-w-0 items-stretch">
        <!-- Left: the generator reads nudges between steps -->
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.1 }"
          :in-view-options="{ once: true }"
          class="block"
        >
          <div class="h-full overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
              <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
                <span class="size-1.5 rounded-full bg-emerald-400" /> server
              </span>
              <span class="font-mono text-xs text-toned">agent.server.ts</span>
            </div>
            <div class="p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
              <pre><code><span class="block">base.<span class="text-amber-400">stream</span>(<span class="text-emerald-400">'run-agent'</span>, {</span><span class="block">  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ task: v.<span class="text-amber-400">string</span>() }),</span><span class="block">  <span class="text-sky-400">chunk</span>: <span class="text-amber-400">t</span>&lt;{ tool: <span class="text-sky-400">string</span> }&gt;(),</span><span class="block -mx-6 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.5rem-2px)] pr-6">  <span class="text-sky-400">nudges</span>: {
    <span class="text-sky-400">stop</span>: <span class="text-violet-400">null</span>,
    <span class="text-sky-400">redirect</span>: v.<span class="text-amber-400">object</span>({ hint: v.<span class="text-amber-400">string</span>() }),
  },</span><span class="block">  <span class="text-violet-400">async</span> *<span class="text-sky-400">run</span>(ctx, { task }) {</span><span class="block">    <span class="text-violet-400">for</span> (<span class="text-violet-400">const</span> step <span class="text-violet-400">of</span> plan) {</span><span class="block -mx-6 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.5rem-2px)] pr-6">      <span class="text-violet-400">const</span> recent = ctx.stream.<span class="text-amber-400">nudges</span>(<span class="text-violet-400">yield</span> step)</span><span class="block">      <span class="text-dimmed">// stop → return · redirect → replan(hint)</span></span><span class="block">    }</span><span class="block">  },</span><span class="block">})</span></code></pre>
            </div>
          </div>
        </Motion>

        <!-- Right: the agent run, redirected between steps -->
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.2 }"
          :in-view-options="{ once: true }"
        >
          <div ref="nudgeRef" class="h-full overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
              <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
                <span class="size-1.5 rounded-full bg-sky-400" /> client
              </span>
              <span class="font-mono text-xs text-toned">stream: run-agent</span>
            </div>

            <div class="p-5 font-mono text-xs sm:text-sm space-y-2.5 min-h-[12rem]">
              <template v-for="(s, i) in agentSteps" :key="i">
                <!-- a real step (a tool call) -->
                <div
                  v-if="s.kind === 'step'"
                  class="flex items-baseline gap-2.5 transition-all duration-300"
                  :class="i < stepShown ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'"
                >
                  <span class="text-violet-300 shrink-0">▸</span>
                  <span class="w-14 text-sky-300">{{ s.tool }}</span>
                  <span class="text-toned">{{ s.detail }}</span>
                </div>
                <!-- a nudge, sent by the client and read at the boundary between steps -->
                <div
                  v-else
                  class="flex items-center gap-2 border border-violet-500/40 bg-violet-500/[0.08] px-3 py-1.5 transition-all duration-300"
                  :class="i < stepShown ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2'"
                >
                  <UIcon name="i-ph-arrow-bend-left-up-duotone" class="size-3.5 text-violet-300 shrink-0" />
                  <span class="text-violet-200">nudge</span>
                  <span class="text-sky-300">{{ s.tool }}</span>
                  <span class="text-toned">{{ s.detail }}</span>
                  <span class="ml-auto text-[11px] text-toned">client → stream</span>
                </div>
              </template>

              <div class="border-t border-muted pt-3 text-xs text-toned">
                <span class="text-emerald-400">&#10003;</span> Stop or redirect at a step boundary — the chunk flow is never corrupted
              </div>
            </div>
          </div>
        </Motion>
      </div>
    </div>

    <!-- Sub-section: durable streams -->
    <div class="mt-20 md:mt-24">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
        class="mb-8"
      >
        <div>
          <p class="section-label">Durable streams</p>
          <h3 class="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-highlighted">
            Lose the socket, keep the stream<span class="text-primary">.</span>
          </h3>
          <p class="mt-5 max-w-xl text-sm leading-relaxed text-toned">
            Mark a stream durable and a disconnected client never loses its place — it picks up mid-stream on reconnect, no replay logic on your side. Two flavors, for two kinds of source.
          </p>
        </div>
      </Motion>

      <div class="space-y-6">
        <!-- Recorded — buffers every chunk, replays the misses (good for AI) -->
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.1 }"
          :in-view-options="{ once: true }"
          class="block"
        >
          <div ref="recordedRef" class="overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
              <UIcon name="i-ph-floppy-disk-duotone" class="size-4 text-primary shrink-0" />
              <span class="min-w-0 shrink truncate font-mono text-xs sm:text-sm text-toned"><span class="text-default">recorded</span> · ask-ai</span>
              <span class="hidden sm:inline-flex items-center gap-1 border border-muted bg-elevated/40 px-2 py-0.5 font-mono text-[10px] text-toned">best for LLM output</span>
              <span class="ml-auto inline-flex min-w-[8.5rem] shrink-0 items-center justify-end gap-1.5 font-mono text-[11px] transition-colors duration-300" :class="durableTone[recStatus.tone]">
                <span class="size-1.5 rounded-full transition-colors duration-300" :class="[durableDot[recStatus.tone], recStatus.tone !== 'ok' ? 'animate-pulse' : '']" />
                {{ recStatus.label }}
              </span>
            </div>

            <div class="flex h-[4.25rem] items-center gap-1.5 overflow-x-auto px-4 font-mono text-[11px] sm:text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <template v-for="(tk, i) in recTokens" :key="i">
                <span
                  v-if="recState[i] !== 'idle'"
                  class="shrink-0 whitespace-nowrap border px-2 py-1 transition-colors duration-300"
                  :class="{
                    'border-emerald-400/50 bg-emerald-500/10 text-emerald-200': recState[i] === 'live',
                    'border-amber-400/50 bg-amber-500/10 text-amber-200': recState[i] === 'buffered',
                    'border-primary/60 bg-primary/10 text-primary': recState[i] === 'replayed',
                  }"
                >
                  {{ tk.trim() }}<span v-if="recState[i] === 'buffered'" class="ml-1.5 text-[9px] uppercase tracking-wide text-amber-300">buffered</span><span v-if="recState[i] === 'replayed'" class="ml-1.5 text-[9px] uppercase tracking-wide text-primary">replayed</span>
                </span>
                <span
                  v-if="recPhase !== 'streaming' && i === 2"
                  :key="`m-${i}`"
                  class="inline-flex items-center gap-1 shrink-0 whitespace-nowrap border px-2 py-1 transition-colors duration-300"
                  :class="recPhase === 'dropped' ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-primary/50 bg-primary/10 text-primary'"
                >
                  <UIcon :name="recPhase === 'dropped' ? 'i-ph-plugs-duotone' : 'i-ph-arrow-clockwise-duotone'" class="size-3.5" />
                  {{ recPhase === 'dropped' ? 'disconnected' : 'reconnected' }}
                </span>
              </template>
            </div>

            <div class="flex flex-col gap-2 border-t border-muted/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p class="text-xs leading-relaxed text-toned">Every chunk is buffered as it sends, so a reconnecting client replays exactly what it missed — your generator never re-runs.</p>
              <code class="shrink-0 border border-muted bg-elevated/40 px-2 py-1 font-mono text-[11px] text-primary">base.recordedStream('ask-ai', …)</code>
            </div>
          </div>
        </Motion>

        <!-- Resumable — stores only a cursor, re-runs from it (good for deterministic sources) -->
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.2 }"
          :in-view-options="{ once: true }"
          class="block"
        >
          <div ref="resumableRef" class="overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
              <UIcon name="i-ph-arrow-counter-clockwise-duotone" class="size-4 text-primary shrink-0" />
              <span class="min-w-0 shrink truncate font-mono text-xs sm:text-sm text-toned"><span class="text-default">resumable</span> · paginate</span>
              <span class="hidden sm:inline-flex items-center gap-1 border border-muted bg-elevated/40 px-2 py-0.5 font-mono text-[10px] text-toned">best for re-runnable sources</span>
              <span class="ml-auto inline-flex min-w-[10.5rem] shrink-0 items-center justify-end gap-1.5 font-mono text-[11px] transition-colors duration-300" :class="durableTone[resStatus.tone]">
                <span class="size-1.5 rounded-full transition-colors duration-300" :class="[durableDot[resStatus.tone], resStatus.tone !== 'ok' ? 'animate-pulse' : '']" />
                {{ resStatus.label }}
              </span>
            </div>

            <div class="flex h-[4.25rem] items-center gap-1.5 overflow-x-auto px-4 font-mono text-[11px] sm:text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <template v-for="r in resRows" :key="r">
                <span
                  v-if="r <= resShown"
                  class="shrink-0 whitespace-nowrap border px-2 py-1 transition-colors duration-300"
                  :class="r <= 3 ? 'border-sky-400/40 bg-sky-500/10 text-sky-200' : 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'"
                >row #{{ r }}</span>
                <span
                  v-if="resPhase !== 'streaming' && r === 3"
                  :key="`rm-${r}`"
                  class="inline-flex items-center gap-1 shrink-0 whitespace-nowrap border px-2 py-1 transition-colors duration-300"
                  :class="resPhase === 'dropped' ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-primary/50 bg-primary/10 text-primary'"
                >
                  <UIcon :name="resPhase === 'dropped' ? 'i-ph-plugs-duotone' : 'i-ph-arrow-clockwise-duotone'" class="size-3.5" />
                  {{ resPhase === 'dropped' ? 'disconnected' : 're-run from idx: 3' }}
                </span>
              </template>
              <span v-if="resShown > 0" class="ml-1 inline-flex shrink-0 whitespace-nowrap items-center gap-1 border border-primary/40 bg-primary/[0.06] px-2 py-1 text-primary">
                <UIcon name="i-ph-map-pin-duotone" class="size-3.5" /> cursor idx: {{ resCursor }}
              </span>
            </div>

            <div class="flex flex-col gap-2 border-t border-muted/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p class="text-xs leading-relaxed text-toned">Only the cursor is stored. On reconnect the generator re-runs from it and continues live — nothing buffered but the position.</p>
              <code class="shrink-0 border border-muted bg-elevated/40 px-2 py-1 font-mono text-[11px] text-primary">base.resumableStream('paginate', …)</code>
            </div>
          </div>
        </Motion>
      </div>

      <p class="mt-6 font-mono text-[11px] text-dimmed">
        Suspended streams are kept for 5 minutes, by default.
      </p>
    </div>
  </section>
</template>

<style scoped>
.flow-wire {
  background-image: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-color-primary-500) 90%, transparent) 0 5px,
    transparent 5px 18px
  );
  background-size: 18px 100%;
  animation: flow-bg 0.55s linear infinite;
  transition: opacity 0.3s ease;
}

@keyframes flow-bg {
  to {
    background-position: 18px 0;
  }
}
</style>
