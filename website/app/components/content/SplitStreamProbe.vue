<script setup lang="ts">
// The probe as a sequence over time, top to bottom. With the switch on, a proxy on the way
// holds the long POST's body, so the probe never reaches the server.
const held = ref(false)

const B = 92
const P = 340
const S = 588
</script>

<template>
  <SplitStreamFigure animated caption="The client writes a tiny probe into the long POST. The server answers on the event stream. An answer within 2 seconds means the whole path streams, and the client moves to stream mode.">
    <div class="mb-3 flex items-center gap-3">
      <USwitch v-model="held" label="A proxy on the way holds request bodies" />
    </div>

    <svg :key="String(held)" viewBox="0 0 680 300" class="w-full" role="img" :aria-label="held ? 'A proxy holds the long POST body. The probe never reaches the server, no answer comes within 2 seconds, and the client stays in batch mode.' : 'The probe reaches the server, the server answers on the event stream within 2 seconds, and the client moves to stream mode.'">
      <defs>
        <marker id="ss-pr-gray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" class="fill-(--ui-text-muted)" />
        </marker>
        <marker id="ss-pr-sky" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" class="fill-sky-500 dark:fill-sky-400" />
        </marker>
        <marker id="ss-pr-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#ff8a3d" />
        </marker>
      </defs>

      <!-- lifelines -->
      <g v-for="[x, name] in [[B, 'Browser'], [P, held ? 'Proxy' : 'Network'], [S, 'Server']] as const" :key="name">
        <rect :x="x - 52" y="10" width="104" height="28" rx="8" :class="name === 'Proxy' ? 'fill-red-500/10 stroke-red-400/70' : 'fill-(--ui-bg) stroke-(--art-line)'" />
        <text :x="x" y="29.5" text-anchor="middle" class="text-[14px] font-semibold fill-(--ui-text-highlighted)">{{ name }}</text>
        <line :x1="x" y1="38" :x2="x" y2="290" class="stroke-(--art-line)" stroke-dasharray="3 4" />
      </g>

      <!-- 1. the event stream opens and stays open -->
      <g class="ss-s1">
        <line :x1="B" y1="62" :x2="S - 4" y2="62" class="stroke-(--ui-text-muted)" stroke-width="1.5" marker-end="url(#ss-pr-gray)" />
        <text :x="(B + S) / 2" y="55" text-anchor="middle" class="text-[13px] fill-(--ui-text-toned)">GET: the event stream opens, and stays open</text>
        <rect :x="S - 3" y="62" width="6" height="228" rx="3" fill="#ff8a3d" class="opacity-40" />
      </g>

      <!-- 2. the first batch POST -->
      <g class="ss-s2">
        <line :x1="B" y1="96" :x2="S - 4" y2="96" class="stroke-sky-500/80" stroke-width="1.5" marker-end="url(#ss-pr-sky)" />
        <text :x="(B + S) / 2" y="89" text-anchor="middle" class="text-[13px] fill-(--ui-text-toned)">POST: the first messages, in batch mode</text>
        <line :x1="S - 4" y1="112" :x2="B + 4" y2="112" class="stroke-(--ui-text-muted)" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ss-pr-gray)" />
        <text :x="B + 12" y="129" class="text-[12.5px] fill-(--ui-text-muted)">204: done, nothing to send back</text>
      </g>

      <!-- 3. the long POST opens with a probe -->
      <g class="ss-s3">
        <line :x1="B" y1="156" :x2="held ? P - 10 : S - 4" y2="156" class="stroke-sky-500" stroke-width="2.5" marker-end="url(#ss-pr-sky)" />
        <rect :x="B + 22" y="144" width="58" height="24" rx="12" class="fill-sky-500 dark:fill-sky-400" />
        <text :x="B + 51" y="160.5" text-anchor="middle" class="font-mono text-[12.5px] fill-white dark:fill-sky-950">probe</text>
        <text :x="held ? (B + P) / 2 + 40 : (B + S) / 2 + 50" y="146" text-anchor="middle" class="text-[13px] fill-(--ui-text-toned)">the long POST opens</text>
      </g>

      <!-- 4a. the server answers on the stream -->
      <g v-if="!held" class="ss-s4">
        <path :d="`M${S - 4} 168 L${B + 4} 196`" stroke="#ff8a3d" stroke-width="2.5" fill="none" marker-end="url(#ss-pr-orange)" />
        <text :x="(B + S) / 2 + 30" y="204" text-anchor="middle" class="text-[13px] fill-orange-700 dark:fill-orange-200">the answer comes down the event stream</text>
      </g>

      <!-- 4b. the proxy holds the body -->
      <g v-else class="ss-s4">
        <rect :x="P - 82" y="172" width="164" height="50" rx="8" class="fill-red-500/10 stroke-red-400/60" />
        <text :x="P" y="192" text-anchor="middle" class="text-[13px] font-medium fill-red-700 dark:fill-red-300">waits for the body</text>
        <text :x="P" y="210" text-anchor="middle" class="text-[13px] fill-red-700 dark:fill-red-300">to end. It never does.</text>
        <g class="ss-clock" :transform="`translate(${B} 196)`">
          <circle r="13" class="fill-(--ui-bg) stroke-(--ui-text-muted)" stroke-width="1.5" />
          <line x1="0" y1="0" x2="0" y2="-8" class="ss-hand stroke-(--ui-text-highlighted)" stroke-width="1.5" stroke-linecap="round" />
        </g>
        <text :x="B + 20" y="223" class="text-[13px] fill-(--ui-text-toned)">2 s, no answer</text>
      </g>

      <!-- 5. the result -->
      <g class="ss-s5">
        <rect :x="B - 70" y="234" width="340" height="50" rx="10" :class="held ? 'fill-sky-500/10 stroke-sky-500/60' : 'fill-orange-500 stroke-orange-300'" />
        <text :x="B + 100" y="255" text-anchor="middle" :class="held ? 'text-[14px] font-semibold fill-sky-700 dark:fill-sky-200' : 'text-[14px] font-semibold fill-white'">{{ held ? 'Stays in batch mode' : 'Moves to stream mode' }}</text>
        <text :x="B + 100" y="273" text-anchor="middle" :class="held ? 'text-[12.5px] fill-(--ui-text-muted)' : 'text-[12.5px] fill-orange-50'">{{ held ? 'and skips the probe on this site for 10 minutes' : 'next messages go into the open POST body' }}</text>
      </g>
    </svg>
  </SplitStreamFigure>
</template>

<style scoped>
.ss-hand {
  transform-box: view-box;
  transform-origin: 0 0;
}

/* Each step shows up in turn, the whole sequence stays for a moment, then it starts again. */
@media (prefers-reduced-motion: no-preference) {
  .ss-s1 { animation: ss-at1 9s ease-out infinite; }
  .ss-s2 { animation: ss-at2 9s ease-out infinite; }
  .ss-s3 { animation: ss-at3 9s ease-out infinite; }
  .ss-s4 { animation: ss-at4 9s ease-out infinite; }
  .ss-s5 { animation: ss-at5 9s ease-out infinite; }
  .ss-hand { animation: ss-tick 9s linear infinite; }
}

@keyframes ss-at1 { 0% { opacity: 0; } 5%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes ss-at2 { 0%, 12% { opacity: 0; } 17%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes ss-at3 { 0%, 26% { opacity: 0; } 31%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes ss-at4 { 0%, 40% { opacity: 0; } 45%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes ss-at5 { 0%, 64% { opacity: 0; } 69%, 94% { opacity: 1; } 100% { opacity: 0; } }

/* The clock hand turns once while the client waits for an answer. */
@keyframes ss-tick {
  0%, 40% { transform: rotate(0deg); }
  64%, 100% { transform: rotate(360deg); }
}
</style>
