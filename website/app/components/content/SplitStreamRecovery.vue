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
  answered: 'fill-green-500/20 stroke-green-500',
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
    <div class="mb-1 flex items-center gap-2 pr-1">
      <UButton size="sm" color="neutral" variant="outline" icon="i-ph-arrow-left" aria-label="Previous step" :disabled="index === 0" @click="index--" />
      <UButton size="sm" color="neutral" variant="outline" icon="i-ph-arrow-right" aria-label="Next step" :disabled="index === steps.length - 1" @click="index++" />
      <div class="ml-1 flex gap-1.5" aria-hidden="true">
        <span v-for="(_, dot) in steps" :key="dot" class="size-2 rounded-full transition-colors" :class="dot === index ? 'bg-primary' : 'bg-accented'" />
      </div>
      <span class="ml-auto text-sm text-muted tabular-nums">Step {{ index + 1 }} of {{ steps.length }}</span>
    </div>

    <p class="mt-3 font-semibold text-highlighted" aria-live="polite">{{ step.title }}</p>
    <p class="mt-1 text-sm text-toned">{{ step.body }}</p>

    <svg viewBox="0 0 680 210" class="mt-3 w-full" role="img" :aria-label="`${step.title}. ${step.body}`">
      <text x="16" y="56" class="text-[14px] font-semibold fill-(--ui-text-highlighted)">Client</text>
      <text x="16" y="73" class="text-[12.5px] fill-(--ui-text-muted)">sent</text>
      <text x="16" y="166" class="text-[14px] font-semibold fill-(--ui-text-highlighted)">Server</text>
      <text x="16" y="183" class="text-[12.5px] fill-(--ui-text-muted)">ran</text>

      <!-- the wire between them -->
      <g v-if="step.wire === 'stream'">
        <line :x1="X0 - 20" y1="108" :x2="cx(N) + 20" y2="108" class="stroke-sky-500" stroke-width="3" />
        <text :x="cx(N) + 26" y="113" class="text-[13px] fill-sky-700 dark:fill-sky-200">long POST</text>
      </g>
      <g v-else-if="step.wire === 'broken'">
        <line :x1="X0 - 20" y1="108" :x2="cx(6) + 12" y2="108" class="stroke-sky-500" stroke-width="3" />
        <line :x1="cx(7) - 12" y1="108" :x2="cx(N) + 20" y2="108" class="stroke-sky-500/40" stroke-width="3" />
        <path :d="`M${cx(6.5) - 9} 99 l18 18 M${cx(6.5) + 9} 99 l-18 18`" class="stroke-red-500" stroke-width="3" stroke-linecap="round" />
        <text :x="cx(N) + 26" y="113" class="text-[13px] fill-red-600 dark:fill-red-400">cut off</text>
      </g>
      <g v-else>
        <rect :x="cx(6) - 24" y="94" :width="cx(8) - cx(6) + 48" height="28" rx="8" class="fill-sky-500/10 stroke-sky-500" stroke-dasharray="4 3" />
        <text :x="cx(N) + 32" y="105" class="text-[13px] fill-sky-700 dark:fill-sky-200">batch POST</text>
        <text :x="cx(N) + 32" y="121" class="text-[12.5px] fill-(--ui-text-muted)">starts at 6</text>
      </g>
      <text v-if="step.answer" :x="X0 - 20" y="90" class="text-[13px] fill-orange-700 dark:fill-orange-200">↑ {{ step.answer }}</text>

      <!-- numbered messages -->
      <g v-for="n in N" :key="n">
        <rect :x="cx(n) - 18" y="40" width="36" height="34" rx="8" class="transition-[fill,stroke] duration-300" :class="clientClass[step.client[n - 1]!]" stroke-width="1.5" />
        <text :x="cx(n)" y="62" text-anchor="middle" class="font-mono text-[15px] font-semibold" :class="step.client[n - 1] === 'resent' ? 'fill-white dark:fill-sky-950' : 'fill-(--ui-text-highlighted)'">{{ n }}</text>
        <path v-if="step.client[n - 1] === 'answered'" :d="`M${cx(n) + 8} 46 l3 3 l6 -6`" class="fill-none stroke-green-600 dark:stroke-green-400" stroke-width="1.6" />

        <rect :x="cx(n) - 18" y="146" width="36" height="34" rx="8" class="transition-[fill,stroke] duration-300" :class="serverClass[step.server[n - 1]!]" stroke-width="1.5" :stroke-dasharray="step.server[n - 1] === 'none' ? '3 3' : undefined" />
        <text :x="cx(n)" y="168" text-anchor="middle" class="font-mono text-[15px]" :class="step.server[n - 1] === 'none' ? 'fill-(--ui-text-dimmed)' : 'font-semibold fill-(--ui-text-highlighted)'">{{ n }}</text>
      </g>
      <g v-if="step.dropped">
        <path :d="`M${cx(step.dropped)} 124 v18`" class="stroke-red-500" stroke-width="1.5" stroke-dasharray="2 2" />
        <text :x="cx(step.dropped)" y="202" text-anchor="middle" class="text-[13px] font-medium fill-red-600 dark:fill-red-400">copy dropped</text>
      </g>
    </svg>

    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-sm border border-green-500 bg-green-500/20" />answered</span>
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-sm border border-sky-500 bg-sky-500/15" />sent, no answer yet</span>
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-sm border border-sky-500 bg-sky-500" />sent again</span>
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-sm border border-orange-400 bg-orange-500/20" />ran on the server</span>
    </div>
  </SplitStreamFigure>
</template>
