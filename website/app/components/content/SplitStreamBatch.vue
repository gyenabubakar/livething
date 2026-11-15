<script setup lang="ts">
// Batch mode: one POST in flight. Messages sent meanwhile wait, and the next POST takes them all.
const queued = ['react', 'start-typing', 'send-message']
const POST1_W = 140
const POST2_W = 172
const LANE = { from: 160, to: 546 }
const TRAVEL1 = LANE.to - LANE.from - POST1_W - 8
const TRAVEL2 = LANE.to - LANE.from - POST2_W - 8
</script>

<template>
  <SplitStreamFigure animated caption="Batch mode keeps one POST in flight. The messages you send meanwhile wait, and the next POST carries all of them, up to 255. Four messages cost two requests. 204 is the server's answer: done, nothing to send back.">
    <svg viewBox="0 0 680 280" class="w-full" role="img" aria-label="The first POST carries one message to the server. While it is in flight, three more messages wait in the browser. When the server answers 204, the second POST carries all three.">
      <!-- browser and its queue -->
      <rect x="10" y="20" width="146" height="222" rx="10" class="fill-(--ui-bg) stroke-(--art-line)" />
      <text x="83" y="46" text-anchor="middle" class="text-[16px] font-semibold fill-(--ui-text-highlighted)">Browser</text>
      <text x="22" y="134" class="text-[12.5px] font-medium uppercase tracking-wider fill-(--ui-text-muted)">waiting</text>
      <g v-for="(label, index) in queued" :key="label" class="ss-queued" :class="`ss-q${index + 1}`">
        <rect x="20" :y="144 + index * 30" width="126" height="24" rx="12" class="fill-sky-500/15 stroke-sky-500/60" />
        <text x="83" :y="160.5 + index * 30" text-anchor="middle" class="font-mono text-[12.5px] fill-sky-700 dark:fill-sky-200">{{ label }}</text>
      </g>

      <!-- server -->
      <rect x="550" y="20" width="120" height="222" rx="10" class="fill-(--ui-bg) stroke-orange-400/70" />
      <text x="610" y="46" text-anchor="middle" class="text-[16px] font-semibold fill-(--ui-text-highlighted)">Server</text>
      <text x="610" y="134" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">runs each</text>
      <text x="610" y="152" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">message</text>
      <text x="610" y="170" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">in order</text>

      <!-- lanes -->
      <line :x1="LANE.from" y1="84" :x2="LANE.to" y2="84" class="stroke-(--art-line)" stroke-dasharray="3 4" />
      <line :x1="LANE.from" y1="180" :x2="LANE.to" y2="180" class="stroke-(--art-line)" stroke-dasharray="3 4" />

      <!-- POST 1: one message -->
      <g class="ss-post1" :style="{ '--travel': `${TRAVEL1}px` }">
        <rect :x="LANE.from + 4" y="60" :width="POST1_W" height="48" rx="8" class="fill-sky-500 dark:fill-sky-400" />
        <text :x="LANE.from + 16" y="79" class="text-[12.5px] font-semibold uppercase tracking-wider fill-white/85 dark:fill-sky-950/75">POST 1</text>
        <text :x="LANE.from + 16" y="98" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">send-message</text>
      </g>
      <g class="ss-ack1">
        <text :x="(LANE.from + LANE.to) / 2" y="128" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">← 204 done</text>
      </g>

      <!-- POST 2: everything that waited -->
      <g class="ss-post2" :style="{ '--travel': `${TRAVEL2}px` }">
        <rect :x="LANE.from + 4" y="140" :width="POST2_W" height="82" rx="8" class="fill-sky-500 dark:fill-sky-400" />
        <text :x="LANE.from + 16" y="159" class="text-[12.5px] font-semibold uppercase tracking-wider fill-white/85 dark:fill-sky-950/75">POST 2 · 3 messages</text>
        <text :x="LANE.from + 16" y="178" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">react</text>
        <text :x="LANE.from + 16" y="195" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">start-typing</text>
        <text :x="LANE.from + 16" y="212" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">send-message</text>
      </g>
      <g class="ss-ack2">
        <text :x="(LANE.from + LANE.to) / 2" y="238" text-anchor="middle" class="text-[13px] fill-(--ui-text-muted)">← 204 done</text>
      </g>

      <text x="340" y="270" text-anchor="middle" class="text-[14px] fill-(--ui-text-muted)">4 messages, 2 POSTs, never more than one in flight</text>
    </svg>
  </SplitStreamFigure>
</template>

<style scoped>
.ss-post1,
.ss-post2 {
  transform-box: view-box;
}

/* With motion off, the picture shows POST 1 on its way and three messages waiting. */
.ss-post1 {
  transform: translateX(120px);
}

.ss-post2,
.ss-ack1,
.ss-ack2 {
  opacity: 0.35;
}

@media (prefers-reduced-motion: no-preference) {
  .ss-post1 { animation: ss-post1 9s ease-in-out infinite; }
  .ss-ack1 { animation: ss-ack1 9s linear infinite; }
  .ss-q1 { animation: ss-q1 9s ease-out infinite; }
  .ss-q2 { animation: ss-q2 9s ease-out infinite; }
  .ss-q3 { animation: ss-q3 9s ease-out infinite; }
  .ss-post2 { animation: ss-post2 9s ease-in-out infinite; }
  .ss-ack2 { animation: ss-ack2 9s linear infinite; }
}

@keyframes ss-post1 {
  0% { transform: translateX(0); opacity: 0; }
  4% { transform: translateX(0); opacity: 1; }
  30% { transform: translateX(var(--travel)); opacity: 1; }
  34%, 100% { transform: translateX(var(--travel)); opacity: 0; }
}

@keyframes ss-ack1 {
  0%, 30% { opacity: 0; }
  33%, 40% { opacity: 1; }
  43%, 100% { opacity: 0; }
}

@keyframes ss-q1 { 0%, 8% { opacity: 0; } 11%, 40% { opacity: 1; } 43%, 100% { opacity: 0; } }
@keyframes ss-q2 { 0%, 15% { opacity: 0; } 18%, 40% { opacity: 1; } 43%, 100% { opacity: 0; } }
@keyframes ss-q3 { 0%, 22% { opacity: 0; } 25%, 40% { opacity: 1; } 43%, 100% { opacity: 0; } }

@keyframes ss-post2 {
  0%, 40% { transform: translateX(0); opacity: 0; }
  44% { transform: translateX(0); opacity: 1; }
  72% { transform: translateX(var(--travel)); opacity: 1; }
  76%, 100% { transform: translateX(var(--travel)); opacity: 0; }
}

@keyframes ss-ack2 {
  0%, 72% { opacity: 0; }
  75%, 86% { opacity: 1; }
  89%, 100% { opacity: 0; }
}
</style>
