<script setup lang="ts">
// What happens when the long POST dies, in four steps. Each message has a number. The client
// keeps every message the server has not answered, and sends them again in batch mode.
type Sent = 'answered' | 'waiting' | 'resent' | 'none'
type Ran = 'ran' | 'none'
interface Step {
  title: string
  body: string
  client: Sent[]
  server: Ran[]
  wire: 'stream' | 'broken' | 'batch'
  answer?: string
  /** The message whose copy the server drops. */
  dropped?: number
}

const N = 8
const fill = <T,>(pick: (n: number) => T) => Array.from({ length: N }, (_, index) => pick(index + 1))

const steps: Step[] = [
  {
    title: 'The long POST carries messages 1 to 8',
    body: 'The server has run 1 to 6. Its answer on the event stream says “up to 5”, so the client knows 1 to 5 arrived.',
    client: fill((n) => (n <= 5 ? 'answered' : 'waiting')),
    server: fill((n) => (n <= 6 ? 'ran' : 'none')),
    wire: 'stream',
    answer: 'answered up to 5',
  },
  {
    title: 'The long POST dies',
    body: 'A proxy cuts it off. Messages 7 and 8 never reached the server. The client cannot know that the server has 6, because its answer did not come yet.',
    client: fill((n) => (n <= 5 ? 'answered' : 'waiting')),
    server: fill((n) => (n <= 6 ? 'ran' : 'none')),
    wire: 'broken',
  },
  {
    title: 'The client sends 6, 7 and 8 again',
    body: 'It sends every message with no answer in one batch POST, and tells the server the first one is number 6.',
    client: fill((n) => (n <= 5 ? 'answered' : 'resent')),
    server: fill((n) => (n <= 6 ? 'ran' : 'none')),
    wire: 'batch',
  },
  {
    title: 'The server drops 6 and runs 7 and 8',
    body: 'It already ran 6, so it drops the copy. Every message ran exactly once, in order. The client stays in batch mode until it connects again.',
    client: fill(() => 'answered'),
    server: fill(() => 'ran'),
    wire: 'batch',
    answer: '204 done',
    dropped: 6,
  },
]

const index = ref(0)
const step = computed(() => steps[index.value]!)

const X0 = 150
const GAP = 52
const cx = (n: number) => X0 + (n - 1) * GAP

const clientClass: Record<Sent, string> = {
  answered: 'fill-emerald-500/20 stroke-emerald-500',
  waiting: 'fill-sky-500/15 stroke-sky-500',
  resent: 'fill-sky-500 stroke-sky-500',
  none: 'fill-transparent stroke-(--art-line)',
}
const serverClass: Record<Ran, string> = {
  ran: 'fill-orange-500/20 stroke-orange-400',
  none: 'fill-transparent stroke-(--art-line)',
}
</script>

<template>
  <SplitStreamFigure caption="Numbers and answers make a broken long POST safe: nothing is lost, and nothing runs twice.">
    <div class="flex items-center gap-2 font-mono text-xs">
      <button v-for="move in [-1, 1]" :key="move" type="button" class="flex size-7 items-center justify-center border border-default text-toned hover:border-primary/60 hover:text-highlighted disabled:opacity-40 disabled:hover:border-default" :aria-label="move < 0 ? 'Previous step' : 'Next step'" :disabled="index + move < 0 || index + move >= steps.length" @click="index += move">
        <UIcon :name="move < 0 ? 'i-ph-arrow-left' : 'i-ph-arrow-right'" class="size-3.5" />
      </button>
      <div class="ml-1 flex gap-1.5" aria-hidden="true">
        <span v-for="(_, dot) in steps" :key="dot" class="size-2 transition-colors" :class="dot === index ? 'bg-primary shadow-[0_0_8px_var(--ui-primary)]' : 'bg-accented'" />
      </div>
      <span class="ml-auto text-muted tabular-nums">step {{ index + 1 }} of {{ steps.length }}</span>
    </div>

    <p class="mt-4 font-semibold text-highlighted" aria-live="polite">{{ step.title }}</p>
    <p class="mt-1 text-sm/6 text-toned">{{ step.body }}</p>

    <svg viewBox="0 0 680 210" class="mt-3 w-full" role="img" :aria-label="`${step.title}. ${step.body}`">
      <g class="font-mono">
        <text x="16" y="56" class="text-[12px] fill-(--ui-text-highlighted)">client</text>
        <text x="16" y="72" class="text-[10.5px] uppercase tracking-widest fill-(--ui-text-muted)">sent</text>
        <text x="16" y="166" class="text-[12px] fill-(--ui-text-highlighted)">server</text>
        <text x="16" y="182" class="text-[10.5px] uppercase tracking-widest fill-(--ui-text-muted)">ran</text>
      </g>

      <!-- the wire between them -->
      <g v-if="step.wire === 'stream'">
        <line :x1="X0 - 20" y1="108" :x2="cx(N) + 20" y2="108" stroke="#38bdf8" stroke-width="2.5" class="ss-glow-up" />
        <text :x="cx(N) + 26" y="112" class="font-mono text-[11px] fill-sky-700 dark:fill-sky-200">long POST</text>
      </g>
      <g v-else-if="step.wire === 'broken'">
        <line :x1="X0 - 20" y1="108" :x2="cx(6) + 12" y2="108" stroke="#38bdf8" stroke-width="2.5" class="ss-glow-up" />
        <line :x1="cx(7) - 12" y1="108" :x2="cx(N) + 20" y2="108" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="3 4" class="opacity-40" />
        <path :d="`M${cx(6.5) - 8} 100 l16 16 M${cx(6.5) + 8} 100 l-16 16`" stroke="#ef4444" stroke-width="2.5" />
        <text :x="cx(N) + 26" y="112" class="font-mono text-[11px] fill-red-600 dark:fill-red-300">cut off</text>
      </g>
      <g v-else>
        <rect :x="cx(6) - 24" y="94" :width="cx(8) - cx(6) + 48" height="28" class="fill-sky-500/10 stroke-sky-500/70" stroke-dasharray="3 3" />
        <text :x="cx(N) + 32" y="105" class="font-mono text-[11px] fill-sky-700 dark:fill-sky-200">batch POST</text>
        <text :x="cx(N) + 32" y="121" class="font-mono text-[10.5px] fill-(--ui-text-muted)">starts at 6</text>
      </g>
      <text v-if="step.answer" :x="X0 - 20" y="90" class="font-mono text-[11px] fill-orange-700 dark:fill-orange-200">↑ {{ step.answer }}</text>

      <!-- numbered messages -->
      <g v-for="n in N" :key="n">
        <rect :x="cx(n) - 18" y="40" width="36" height="34" class="transition-[fill,stroke] duration-300" :class="clientClass[step.client[n - 1]!]" stroke-width="1.5" />
        <text :x="cx(n)" y="62" text-anchor="middle" class="font-mono text-[15px] font-semibold" :class="step.client[n - 1] === 'resent' ? 'fill-white dark:fill-sky-950' : 'fill-(--ui-text-highlighted)'">{{ n }}</text>
        <path v-if="step.client[n - 1] === 'answered'" :d="`M${cx(n) + 8} 46 l3 3 l6 -6`" class="fill-none stroke-emerald-600 dark:stroke-emerald-300" stroke-width="1.6" />

        <rect :x="cx(n) - 18" y="146" width="36" height="34" class="transition-[fill,stroke] duration-300" :class="serverClass[step.server[n - 1]!]" stroke-width="1.5" :stroke-dasharray="step.server[n - 1] === 'none' ? '3 3' : undefined" />
        <text :x="cx(n)" y="168" text-anchor="middle" class="font-mono text-[15px]" :class="step.server[n - 1] === 'none' ? 'fill-(--ui-text-dimmed)' : 'font-semibold fill-(--ui-text-highlighted)'">{{ n }}</text>
      </g>
      <g v-if="step.dropped">
        <path :d="`M${cx(step.dropped)} 124 v18`" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="2 2" />
        <text :x="cx(step.dropped)" y="202" text-anchor="middle" class="font-mono text-[11px] fill-red-600 dark:fill-red-300">copy dropped</text>
      </g>
    </svg>

    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
      <span class="flex items-center gap-1.5"><span class="size-3 border border-emerald-500 bg-emerald-500/20" />answered</span>
      <span class="flex items-center gap-1.5"><span class="size-3 border border-sky-500 bg-sky-500/15" />sent, no answer yet</span>
      <span class="flex items-center gap-1.5"><span class="size-3 border border-sky-500 bg-sky-500" />sent again</span>
      <span class="flex items-center gap-1.5"><span class="size-3 border border-orange-400 bg-orange-500/20" />ran on the server</span>
    </div>
  </SplitStreamFigure>
</template>
