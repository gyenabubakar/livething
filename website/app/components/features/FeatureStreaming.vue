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
const tokens = ['WSKit ', 'gives ', 'your ', 'server ', 'and ', 'client ', 'one ', 'inferred ', 'contract, ', 'so ', 'realtime ', 'stays ', 'type-safe ', 'end ', 'to ', 'end.']
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
        if (entry?.isIntersecting && !tickInterval) tickInterval = setInterval(tick, 170)
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
      <!-- Left: the server generator -->
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
            <span class="ml-3 font-mono text-xs text-dimmed">ai.ts</span>
            <span class="ml-auto font-mono text-[10px] text-dimmed">server</span>
          </div>
          <div class="p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">export const</span> handleAsk = base.<span class="text-amber-400">stream</span>(<span class="text-emerald-400">'ask-ai'</span>, {
  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ prompt: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">chunk</span>: <span class="text-amber-400">t</span>&lt;{ token: <span class="text-sky-400">string</span> }&gt;(),
  <span class="text-violet-400">async</span> *<span class="text-sky-400">run</span>(ctx, { prompt }) {
    <span class="text-violet-400">for await</span> (<span class="text-violet-400">const</span> token <span class="text-violet-400">of</span> <span class="text-amber-400">llm</span>(prompt)) {
      <span class="text-violet-400">yield</span> { token } <span class="text-dimmed">// one chunk on the wire</span>
    }
  },
})

<span class="text-violet-400">export const</span> handler = base.<span class="text-amber-400">assemble</span>(handleAsk)
<span class="text-violet-400">export type</span> <span class="text-sky-400">AiSocket</span> = <span class="text-amber-400">InferClient</span>&lt;<span class="text-violet-400">typeof</span> handler&gt;</code></pre>
          </div>
        </div>
      </Motion>

      <!-- Right: chunks arriving live -->
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
            <span class="ml-3 font-mono text-xs text-dimmed">stream: ask-ai</span>
            <span
              class="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] transition-colors duration-300"
              :class="phase === 'done' ? 'text-emerald-500' : 'text-amber-500'"
            >
              <span
                class="size-1.5 rounded-full"
                :class="phase === 'done' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'"
              />
              {{ phase === 'done' ? 'complete' : 'streaming' }}
            </span>
          </div>

          <div class="p-5 font-mono text-xs sm:text-sm">
            <div class="text-dimmed">
              <span class="text-violet-400">await</span> socket.<span class="text-amber-400">stream</span>(<span class="text-emerald-400">'ask-ai'</span>, { prompt: <span class="text-emerald-400">'what is wskit?'</span> })
            </div>

            <div class="mt-4 min-h-[5.5rem] border-l-2 border-amber-500/30 pl-3 leading-relaxed text-muted">
              {{ visibleText }}<span
                v-if="phase === 'streaming'"
                class="inline-block w-1.5 h-3.5 -mb-0.5 bg-amber-400 animate-pulse"
              />
            </div>

            <div class="mt-5 border-t border-muted pt-3 flex items-center justify-between text-xs text-dimmed">
              <span><span class="text-amber-400">←</span> chunk <span class="text-muted">{{ '{ token }' }}</span></span>
              <span class="tabular-nums">{{ shown }} / {{ tokens.length }} received</span>
            </div>
          </div>
        </div>
      </Motion>
    </div>

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
          <p class="mt-5 max-w-xl text-sm leading-relaxed text-muted">
            You can't rewrite a token once it's out — but between steps, like an agent's tool calls, a nudge is a typed message the client sends into a running stream. The generator reads it right where it yields, so you can <span class="text-highlighted">stop</span> or <span class="text-highlighted">redirect</span> a run without tearing it down.
          </p>
        </div>
      </Motion>

      <div class="grid gap-6 lg:grid-cols-2 *:min-w-0">
        <!-- Left: nudges read between steps -->
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
              <span class="ml-3 font-mono text-xs text-dimmed">agent.ts</span>
              <span class="ml-auto font-mono text-[10px] text-dimmed">server</span>
            </div>
            <div class="p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
              <pre><code><span class="block">base.<span class="text-amber-400">stream</span>(<span class="text-emerald-400">'run-agent'</span>, {</span><span class="block">  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ task: v.<span class="text-amber-400">string</span>() }),</span><span class="block">  <span class="text-sky-400">chunk</span>: <span class="text-amber-400">t</span>&lt;{ tool: <span class="text-sky-400">string</span> }&gt;(),</span><span class="block -mx-6 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.5rem-2px)] pr-6">  <span class="text-sky-400">nudges</span>: {
    <span class="text-sky-400">stop</span>: <span class="text-violet-400">null</span>,
    <span class="text-sky-400">redirect</span>: v.<span class="text-amber-400">object</span>({ hint: v.<span class="text-amber-400">string</span>() }),
  },</span><span class="block">  <span class="text-violet-400">async</span> *<span class="text-sky-400">run</span>(ctx, { task }) {</span><span class="block">    <span class="text-violet-400">let</span> plan = <span class="text-violet-400">await</span> <span class="text-amber-400">planSteps</span>(task)</span><span class="block">    <span class="text-violet-400">for</span> (<span class="text-violet-400">const</span> step <span class="text-violet-400">of</span> plan) {</span><span class="block">      <span class="text-dimmed">// read between steps — never mid-token</span></span><span class="block -mx-6 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.5rem-2px)] pr-6">      <span class="text-violet-400">const</span> recent = ctx.stream.<span class="text-amber-400">nudges</span>(<span class="text-violet-400">yield</span> step)</span><span class="block">      <span class="text-violet-400">if</span> (recent.<span class="text-amber-400">some</span>((n) => n.event === <span class="text-emerald-400">'stop'</span>)) <span class="text-violet-400">return</span></span><span class="block">      <span class="text-violet-400">const</span> r = recent.<span class="text-amber-400">find</span>((n) => n.event === <span class="text-emerald-400">'redirect'</span>)</span><span class="block">      <span class="text-violet-400">if</span> (r) plan = <span class="text-violet-400">await</span> <span class="text-amber-400">replan</span>(task, r.payload.hint)</span><span class="block">    }</span><span class="block">  },</span><span class="block">})</span></code></pre>
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
            <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
              <div class="flex gap-1.5">
                <div class="size-3 rounded-full bg-accented" />
                <div class="size-3 rounded-full bg-accented" />
                <div class="size-3 rounded-full bg-accented" />
              </div>
              <span class="ml-3 font-mono text-xs text-dimmed">stream: run-agent</span>
            </div>

            <div class="p-5 font-mono text-xs sm:text-sm space-y-2.5 min-h-[12rem]">
              <template v-for="(s, i) in agentSteps" :key="i">
                <!-- a real step (a tool call) -->
                <div
                  v-if="s.kind === 'step'"
                  class="flex items-baseline gap-2.5 transition-all duration-300"
                  :class="i < stepShown ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'"
                >
                  <span class="text-violet-400 shrink-0">▸</span>
                  <span class="w-14 text-sky-400">{{ s.tool }}</span>
                  <span class="text-muted">{{ s.detail }}</span>
                </div>
                <!-- a nudge, read at the boundary between steps -->
                <div
                  v-else
                  class="flex items-center gap-2 border border-violet-500/30 bg-violet-500/[0.07] px-3 py-1.5 transition-all duration-300"
                  :class="i < stepShown ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'"
                >
                  <UIcon name="i-ph-arrows-left-right-duotone" class="size-3.5 text-violet-400 shrink-0" />
                  <span class="text-violet-300">nudge</span>
                  <span class="text-sky-400">{{ s.tool }}</span>
                  <span class="text-muted">{{ s.detail }}</span>
                  <span class="ml-auto text-[10px] text-dimmed">between steps</span>
                </div>
              </template>

              <div class="border-t border-muted pt-3 text-xs text-dimmed">
                <span class="text-emerald-500">&#10003;</span> Stop or redirect at a step boundary — the chunk flow is never corrupted
              </div>
            </div>
          </div>
        </Motion>
      </div>
    </div>
  </section>
</template>
