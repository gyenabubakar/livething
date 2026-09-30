<script setup lang="ts">
// A text-only statement. Each word starts faint and lights up in reading order
// as the paragraph scrolls through the screen; `accent` words turn orange.
type Part = { text: string, accent?: boolean }

const props = defineProps<{ parts?: Part[] }>()

const defaultParts: Part[] = [
  { text: 'LiveThing is the realtime layer you would otherwise build yourself.' },
  { text: 'Write your server once, and every event, room, request and stream it declares becomes' },
  { text: 'a typed call on the client.', accent: true },
  { text: 'No schema file, no code generation, no third-party service. It runs on' },
  { text: 'your own servers,', accent: true },
  { text: 'and it comes' },
  { text: 'batteries included:', accent: true },
  { text: 'channels, requests, streaming, reliability and more.' },
]

const words = (props.parts ?? defaultParts).flatMap(part => part.text.split(' ').map(word => ({ word, accent: part.accent })))
</script>

<template>
  <section class="frame-row px-6 sm:px-10 py-24 md:py-36">
    <p class="statement mx-auto max-w-5xl font-serif text-3xl/tight font-semibold tracking-tight sm:text-4xl/tight lg:text-5xl/tight">
      <template v-for="(item, index) in words" :key="index">
        <span
          class="statement-word"
          :class="item.accent ? 'text-primary' : 'text-highlighted'"
          :style="{ '--p': index / words.length }"
        >{{ item.word }}</span>{{ ' ' }}
      </template>
    </p>
  </section>
</template>

<style scoped>
.statement {
  view-timeline-name: --statement;
}

@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .statement-word {
      animation: statement-word linear both;
      animation-timeline: --statement;
      /* Word n lights up a little after word n - 1, while the paragraph
         travels from the lower part of the screen towards the middle. */
      animation-range:
        cover calc(20% + var(--p) * 30%)
        cover calc(24% + var(--p) * 30%);
    }
  }
}

@keyframes statement-word {
  from { opacity: 0.15; }
  to { opacity: 1; }
}
</style>
