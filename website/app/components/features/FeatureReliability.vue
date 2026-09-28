<script setup lang="ts">
import { createTimeline, stagger } from 'animejs'

defineProps<{ link?: string, linkLabel?: string }>()

// One reconnect, told as a sequence diagram: time runs down, the client is on
// the left and the server on the right. Each row appears in turn and stays, so
// the whole story is on screen by the end of the loop.
type Row =
  | { kind: 'band', tone: 'lost' | 'back', label: string }
  | { kind: 'retry', label: string }
  | { kind: 'message', dir: 'up' | 'down', event: string, note: string, tone: 'ok' | 'held' | 'missed' | 'dropped' }

const rows: Row[] = [
  { kind: 'message', dir: 'up', event: 'send-message', note: 'delivered', tone: 'ok' },
  { kind: 'band', tone: 'lost', label: 'connection lost' },
  { kind: 'message', dir: 'up', event: 'send-message', note: 'buffered on the client', tone: 'held' },
  { kind: 'message', dir: 'down', event: 'message', note: 'missed while offline', tone: 'missed' },
  { kind: 'retry', label: 'retry in 1s · 2s · 4s' },
  { kind: 'band', tone: 'back', label: 'reconnected' },
  { kind: 'message', dir: 'up', event: 'send-message', note: 'buffer flushed', tone: 'ok' },
  { kind: 'message', dir: 'down', event: 'message', note: 'replayed', tone: 'ok' },
  { kind: 'message', dir: 'down', event: 'message', note: 'duplicate dropped', tone: 'dropped' },
]

const toneLine = {
  ok: 'border-emerald-500/70',
  held: 'border-amber-500/70 border-dashed',
  missed: 'border-red-500/50 border-dashed',
  dropped: 'border-zinc-500/50 border-dashed',
}
const toneText = {
  ok: 'text-emerald-600 dark:text-emerald-300',
  held: 'text-amber-700 dark:text-amber-300',
  missed: 'text-red-600 dark:text-red-300',
  dropped: 'text-muted',
}

const art = ref<HTMLElement>()

useIllustration(art, () => createTimeline({ loop: true, autoplay: false, loopDelay: 400 })
  .add('.rl-row', { opacity: [0, 1], translateY: [-6, 0], duration: 350, delay: stagger(700), ease: 'outQuad' }, 200)
  .add('.rl-row', { opacity: 0, duration: 400, ease: 'linear' }, 200 + rows.length * 700 + 2400))
</script>

<template>
  <LandingFeatureCell :link :link-label>
    <template #headline><slot name="headline" mdc-unwrap="p" /></template>
    <template #title><slot name="title" mdc-unwrap="p" /></template>
    <template #description><slot name="description" mdc-unwrap="p" /></template>
    <template #art>
      <div ref="art" class="absolute inset-0 flex flex-col px-6 sm:px-10 py-6 font-mono text-[11px]">
        <div class="grid grid-cols-[4.5rem_1fr_4.5rem] items-center pb-2 text-toned">
          <span>client</span>
          <span class="text-center text-[10px] uppercase tracking-widest text-zinc-500">time ↓</span>
          <span class="text-right">server</span>
        </div>

        <div class="relative flex flex-1 flex-col justify-around">
          <!-- the two lifelines -->
          <div class="absolute inset-y-0 left-9 border-l border-default" />
          <div class="absolute inset-y-0 right-9 border-l border-default" />

          <div v-for="(row, index) in rows" :key="index" class="rl-row rm-show relative opacity-0">
            <div
              v-if="row.kind === 'band'"
              class="mx-2 py-1 text-center text-[10px] uppercase tracking-widest"
              :class="row.tone === 'lost' ? 'bg-red-500/10 text-red-600 dark:text-red-300' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'"
            >
              {{ row.label }}
            </div>

            <div v-else-if="row.kind === 'retry'" class="pl-12 text-muted">
              {{ row.label }}
            </div>

            <div v-else class="relative mx-9 flex h-7 items-end pb-1">
              <span class="h-0 flex-1 border-t" :class="[toneLine[row.tone], row.tone === 'held' && 'max-w-[35%]', row.tone === 'missed' && 'ml-[65%]']" />
              <span
                class="absolute bottom-1 size-0 translate-y-1/2 border-y-4 border-y-transparent"
                :class="row.dir === 'up'
                  ? ['border-l-[6px] border-l-current', row.tone === 'held' ? 'left-[35%]' : 'right-0', toneText[row.tone]]
                  : ['border-r-[6px] border-r-current', row.tone === 'missed' ? 'left-[65%] -ml-1.5' : 'left-0', toneText[row.tone]]"
              />
              <span class="absolute top-0 left-1/2 -translate-x-1/2 whitespace-nowrap leading-none">
                <span class="text-toned">{{ row.event }}</span>
                <span class="text-[10px]" :class="toneText[row.tone]"> · {{ row.note }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </LandingFeatureCell>
</template>
