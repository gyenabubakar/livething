<script setup lang="ts">
// The same Split Stream on HTTP/1.1 and on HTTP/2. HTTP/1.1 needs a connection for each open
// request, from six per site. HTTP/2 carries them all in one.
const parts = [
  { label: 'event stream', down: true },
  { label: 'batch POST', down: false },
  { label: 'ping and pong POST', down: false },
]
</script>

<template>
  <SplitStreamFigure animated caption="On HTTP/1.1 a Split Stream can hold three of the six connections a browser allows for one site, shared by every tab. On HTTP/2 it all fits in one connection, and only there can the client use stream mode.">
    <svg viewBox="0 0 680 270" class="w-full" role="img" aria-label="Left, HTTP/1.1: three separate connections, three of the six a browser allows for one site. Right, HTTP/2: one connection carries the event stream and the POSTs together.">
      <!-- HTTP/1.1 -->
      <text x="16" y="24" class="text-[15px] font-semibold fill-(--ui-text-highlighted)">HTTP/1.1</text>
      <rect x="16" y="40" width="64" height="146" rx="8" class="fill-(--ui-bg) stroke-(--art-line)" />
      <text x="48" y="118" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Browser</text>
      <rect x="262" y="40" width="64" height="146" rx="8" class="fill-(--ui-bg) stroke-orange-400/70" />
      <text x="294" y="118" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Server</text>
      <g v-for="(part, index) in parts" :key="part.label">
        <rect x="86" :y="64 + index * 46" width="170" height="26" rx="13" class="fill-transparent stroke-(--art-line)" />
        <line x1="98" :y1="77 + index * 46" x2="244" :y2="77 + index * 46" stroke-width="2" :class="part.down ? 'ss-flow-down stroke-orange-400' : 'ss-flow-up stroke-sky-500'" stroke-dasharray="6 4" />
        <text x="171" :y="59 + index * 46" text-anchor="middle" class="text-[12.5px] fill-(--ui-text-muted)">{{ part.label }}</text>
      </g>

      <!-- six slots per site -->
      <text x="16" y="212" class="text-[13px] fill-(--ui-text-muted)">Connections to this site, all tabs:</text>
      <g v-for="slot in 6" :key="slot">
        <rect :x="16 + (slot - 1) * 26" y="222" width="20" height="16" rx="3" :class="slot <= 3 ? 'fill-orange-500/70' : 'fill-transparent stroke-(--art-line)'" />
      </g>
      <text x="16" y="260" class="text-[13px] fill-(--ui-text-muted)">stream mode: not allowed</text>

      <line x1="340" y1="16" x2="340" y2="262" class="stroke-(--art-line)" />

      <!-- HTTP/2 -->
      <text x="358" y="24" class="text-[15px] font-semibold fill-(--ui-text-highlighted)">HTTP/2</text>
      <rect x="358" y="40" width="64" height="146" rx="8" class="fill-(--ui-bg) stroke-(--art-line)" />
      <text x="390" y="118" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Browser</text>
      <rect x="600" y="40" width="64" height="146" rx="8" class="fill-(--ui-bg) stroke-orange-400/70" />
      <text x="632" y="118" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Server</text>
      <rect x="428" y="74" width="166" height="84" rx="20" class="fill-orange-500/[0.05] stroke-orange-400/60" />
      <text x="511" y="66" text-anchor="middle" class="text-[12.5px] fill-(--ui-text-muted)">one connection</text>
      <g v-for="(part, index) in parts" :key="`h2${part.label}`">
        <line x1="440" :y1="94 + index * 22" x2="582" :y2="94 + index * 22" stroke-width="2" :class="part.down ? 'ss-flow-down stroke-orange-400' : 'ss-flow-up stroke-sky-500'" stroke-dasharray="6 4" />
      </g>
      <text x="511" y="178" text-anchor="middle" class="text-[12.5px] fill-(--ui-text-muted)">all three inside it</text>

      <text x="358" y="212" class="text-[13px] fill-(--ui-text-muted)">Connections to this site, all tabs:</text>
      <rect x="358" y="222" width="20" height="16" rx="3" class="fill-orange-500/70" />
      <text x="358" y="260" class="text-[13px] font-medium fill-green-600 dark:fill-green-400">stream mode: allowed</text>
    </svg>
  </SplitStreamFigure>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .ss-flow-down {
    animation: ss-dash 0.9s linear infinite reverse;
  }

  .ss-flow-up {
    animation: ss-dash 0.9s linear infinite;
  }
}

@keyframes ss-dash {
  from {
    stroke-dashoffset: 10;
  }
  to {
    stroke-dashoffset: 0;
  }
}
</style>
