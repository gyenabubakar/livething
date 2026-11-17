<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

// The probe as a sequence diagram, time running down, in the landing page's style. With the
// switch on, a proxy on the way holds the long POST's body, so the probe never reaches the
// server. Both stories stay in the page and the switch shows one, so the timeline keeps its
// targets.
type Arrow = { kind: 'arrow', from: Lifeline, to: Lifeline, label: string, tone: Tone, probe?: boolean }
type Band = { kind: 'band', label: string, tone: Tone }
type Row = Arrow | Band
type Lifeline = 'browser' | 'middle' | 'server'
type Tone = 'plain' | 'up' | 'down' | 'answer' | 'red' | 'stream' | 'batch'

const X: Record<Lifeline, number> = { browser: 10, middle: 50, server: 90 }

const start: Row[] = [
  { kind: 'arrow', from: 'browser', to: 'server', label: 'GET · the event stream opens, and stays open', tone: 'plain' },
  { kind: 'arrow', from: 'browser', to: 'server', label: 'POST · the first messages, in batch mode', tone: 'up' },
  { kind: 'arrow', from: 'server', to: 'browser', label: '204 · done, nothing to send back', tone: 'answer' },
]
const stories: Record<'clear' | 'held', Row[]> = {
  clear: [
    ...start,
    { kind: 'arrow', from: 'browser', to: 'server', label: 'the long POST opens', tone: 'up', probe: true },
    { kind: 'arrow', from: 'server', to: 'browser', label: 'the answer, down the event stream', tone: 'down' },
    { kind: 'band', label: 'answered within 2 s · moves to stream mode', tone: 'stream' },
  ],
  held: [
    ...start,
    { kind: 'arrow', from: 'browser', to: 'middle', label: 'the long POST opens', tone: 'up', probe: true },
    { kind: 'band', label: 'the proxy waits for the body to end · it never does', tone: 'red' },
    { kind: 'band', label: '2 s, no answer · stays in batch mode, skips the probe here for 10 min', tone: 'batch' },
  ],
}

const line: Record<Tone, string> = {
  plain: 'border-(--ui-text-muted)',
  up: 'border-sky-500',
  down: 'border-orange-400',
  answer: 'border-(--ui-text-muted) border-dashed',
  red: '',
  stream: '',
  batch: '',
}
const head: Record<Tone, string> = {
  plain: 'text-(--ui-text-muted)',
  up: 'text-sky-500',
  down: 'text-orange-400',
  answer: 'text-(--ui-text-muted)',
  red: '',
  stream: '',
  batch: '',
}
const band: Record<Tone, string> = {
  plain: '',
  up: '',
  down: '',
  answer: '',
  red: 'bg-red-500/10 text-red-600 dark:text-red-300',
  stream: 'bg-orange-500/15 text-orange-700 dark:text-orange-200',
  batch: 'bg-sky-500/10 text-sky-700 dark:text-sky-200',
}

const arrowStyle = (row: Arrow) => ({
  left: `${Math.min(X[row.from], X[row.to])}%`,
  width: `${Math.abs(X[row.to] - X[row.from])}%`,
})

const held = ref(false)
const paused = ref(false)
const art = ref<HTMLElement>()

useIllustration(art, () => {
  const rows = stories.clear.length
  const reveal = { opacity: [0, 1], translateY: [-6, 0], duration: 350, delay: stagger(800), ease: 'outQuad' }
  return createTimeline({ loop: true, autoplay: false, loopDelay: 400 })
    .add('.pr-clear', reveal, 200)
    .add('.pr-held', reveal, 200)
    .add(['.pr-clear', '.pr-held'], { opacity: 0, duration: 400, ease: 'linear' }, 200 + rows * 800 + 2600)
}, { paused })
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="The client writes a tiny probe into the long POST. The server answers on the event stream. An answer within 2 seconds means the whole path streams, and the client moves to stream mode.">
    <div class="mb-4 flex items-center gap-3">
      <USwitch v-model="held" label="A proxy on the way holds request bodies" />
    </div>

    <div ref="art" class="ss-probe font-mono text-[12px]" role="img" :aria-label="held ? 'A proxy holds the long POST body. The probe never reaches the server, no answer comes within 2 seconds, and the client stays in batch mode.' : 'The probe reaches the server, the server answers on the event stream within 2 seconds, and the client moves to stream mode.'">
      <div class="relative h-7">
        <span v-for="(x, name) in X" :key="name" class="absolute top-0 -translate-x-1/2 border px-2 py-0.5" :style="{ left: `${x}%` }" :class="name === 'middle' && held ? 'border-red-400/60 bg-red-500/10 text-red-600 dark:text-red-300' : name === 'server' ? 'border-orange-400/60 bg-(--art-top) text-highlighted' : 'border-default bg-(--art-top) text-highlighted'">
          {{ name === 'middle' ? (held ? 'proxy' : 'network') : name }}
        </span>
      </div>

      <div class="relative mt-2 flex flex-col gap-1.5 pb-2">
        <div v-for="(x, name) in X" :key="name" class="absolute inset-y-0 border-l border-dashed border-default" :style="{ left: `${x}%` }" />

        <template v-for="(rows, story) in stories" :key="story">
          <div v-for="(row, index) in rows" v-show="(story === 'held') === held" :key="`${story}-${index}`" :class="`pr-${story}`" class="rm-show relative h-9 opacity-0">
            <template v-if="row.kind === 'arrow'">
              <div class="absolute bottom-2 border-t-2" :class="line[row.tone]" :style="arrowStyle(row)">
                <span
                  class="absolute -top-[5px] size-0 border-y-4 border-y-transparent"
                  :class="[head[row.tone], X[row.to] > X[row.from] ? '-right-px border-l-[7px] border-l-current' : '-left-px border-r-[7px] border-r-current']"
                />
                <span v-if="row.probe" class="ss-glow-up absolute -top-[9px] left-3 bg-sky-400 px-1.5 text-[10.5px] leading-4 text-sky-950">probe</span>
              </div>
              <span class="absolute top-0 whitespace-nowrap text-[11px] text-toned" :style="{ left: `${(X[row.from] + X[row.to]) / 2}%` }" style="transform: translateX(-50%)">{{ row.label }}</span>
            </template>
            <div v-else class="absolute inset-x-[4%] top-1 py-1.5 text-center text-[11px] uppercase tracking-wider" :class="band[row.tone]">
              {{ row.label }}
            </div>
          </div>
        </template>
      </div>
    </div>
  </SplitStreamFigure>
</template>

<style scoped>
.ss-probe {
  min-width: 560px;
}
</style>
