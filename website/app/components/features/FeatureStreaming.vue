<script setup lang="ts">
import { Motion } from 'motion-v'

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
let observer: IntersectionObserver | undefined
let nudgeObserver: IntersectionObserver | undefined

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

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (prefersReducedMotion.value) {
    shown.value = tokens.length
    phase.value = 'done'
    stepShown.value = agentSteps.length
    return
  }

  if (demoRef.value) {
    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !tickInterval) tickInterval = setInterval(tick, 150)
      },
      { threshold: 0.3 },
    )
    observer.observe(demoRef.value)
  }

  if (nudgeRef.value) {
    nudgeObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !stepInterval) stepInterval = setInterval(stepTick, 950)
      },
      { threshold: 0.3 },
    )
    nudgeObserver.observe(nudgeRef.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  nudgeObserver?.disconnect()
  if (tickInterval) clearInterval(tickInterval)
  if (restartTimer) clearTimeout(restartTimer)
  if (stepInterval) clearInterval(stepInterval)
  if (stepRestart) clearTimeout(stepRestart)
})
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + server generator code -->
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
          <NuxtLink v-if="props.link" :to="props.link" class="mt-5 group inline-flex items-center gap-2 border border-primary/40 bg-primary/[0.06] px-4 py-2 font-mono text-xs text-primary hover:bg-primary/15 hover:border-primary/60 transition-colors">
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
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">ai.server.ts</span>
          </div>
          <div class="p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
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
            You can't rewrite a token once it's out — but between steps, like an agent's tool calls, a nudge is a typed message the client sends back into a running stream. The generator reads it right where it yields, so you can <span class="text-highlighted">stop</span> or <span class="text-highlighted">redirect</span> a run without tearing it down.
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
