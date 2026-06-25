<script setup lang="ts">
import { Motion } from 'motion-v'

// Features that don't get their own section above — the rest of what you'd
// otherwise hand-roll to ship a websocket-first realtime app. No animation:
// this is a reference wall, read at a glance. Sizes vary (bento).
const features = [
  {
    title: 'Typed errors',
    icon: 'i-ph-warning-octagon-duotone',
    desc: 'Register errors on the server and they land in the client contract. Catch them by type and narrow with .matches() — no string-sniffing, no guessing what failed.',
    code: 'if (NotFound.matches(err)) …',
    size: 'hero',
  },
  { title: 'Auth on connect', icon: 'i-ph-key-duotone', desc: 'The upgrade gate runs during the handshake — reject a connection before the socket ever opens.' },
  { title: 'Scheduled work', icon: 'i-ph-clock-duotone', desc: 'Run server-side tasks on a timer or interval — cleanup, heartbeats, deferred jobs, no connection needed.' },
  { title: 'Rate limiting', icon: 'i-ph-gauge-duotone', desc: 'Cap how fast any one connection can send, so a flood never takes the server down.' },
  { title: 'Tags', icon: 'i-ph-tag-duotone', desc: 'Label connections by user, role, or team, then address everyone sharing a label as one group.' },
  {
    title: 'Plugins',
    icon: 'i-ph-puzzle-piece-duotone',
    desc: 'Package your own capabilities as self-contained, typed add-ons — extra handlers, context, and wire messages that compose like the built-ins.',
    size: 'wide',
  },
  { title: 'Gap detection', icon: 'i-ph-list-numbers-duotone', desc: 'Every outgoing message carries a rising sequence number, so the client notices the instant one goes missing — a jump from 41 to 45 means three were dropped.' },
  { title: 'Connection quality', icon: 'i-ph-cell-signal-high-duotone', desc: 'A live quality tier from round-trip latency, so your UI can react the moment the connection degrades.' },
]
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5 }"
      :in-view-options="{ once: true }"
    >
      <div class="mx-auto mb-10 max-w-2xl text-center">
        <p v-if="$slots.headline" class="section-label justify-center">
          <slot name="headline" mdc-unwrap="p" />
        </p>
        <div class="relative mb-5 mt-1">
          <h2 class="section-title">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </h2>
          <div aria-hidden="true" class="absolute inset-0 section-title blur-xs animate-pulse pointer-events-none">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </div>
        </div>
        <p v-if="$slots.description" class="mx-auto max-w-xl text-sm leading-relaxed text-toned [&_code]:font-mono [&_code]:text-primary [&_code]:bg-elevated/60 [&_code]:border [&_code]:border-muted [&_code]:px-1 [&_code]:py-0.5">
          <slot name="description" mdc-unwrap="p" />
        </p>
      </div>
    </Motion>

    <!-- bento mosaic: one hero tile, one wide tile, the rest a uniform wall -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.1 }"
      :in-view-options="{ once: true }"
      class="block"
    >
      <div class="bento">
        <div
          v-for="f in features"
          :key="f.title"
          class="group relative flex flex-col overflow-hidden border border-muted bg-gradient-to-b from-elevated/25 to-default p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_10px_34px] hover:shadow-black/40"
          :class="{ 'bento-hero': f.size === 'hero', 'bento-wide': f.size === 'wide' }"
        >
          <span
            aria-hidden="true"
            class="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-primary/[0.06] blur-2xl transition-opacity duration-300 group-hover:bg-primary/[0.12]"
          />
          <span
            class="inline-flex items-center justify-center border border-primary/25 bg-primary/[0.08] text-primary transition-colors group-hover:border-primary/50"
            :class="f.size === 'hero' ? 'size-12' : 'size-10'"
          >
            <UIcon :name="f.icon" :class="f.size === 'hero' ? 'size-6' : 'size-5'" />
          </span>
          <h3
            class="mt-4 font-semibold tracking-tight text-highlighted"
            :class="f.size === 'hero' ? 'text-xl md:text-2xl' : 'text-base'"
          >
            {{ f.title }}
          </h3>
          <p
            class="mt-2 leading-relaxed text-toned"
            :class="f.size === 'hero' ? 'text-sm max-w-md' : 'text-[13px]'"
          >
            {{ f.desc }}
          </p>
          <code
            v-if="f.code"
            class="mt-auto inline-block w-fit border border-muted bg-elevated/50 px-2 py-1 font-mono text-xs text-primary"
          >{{ f.code }}</code>
        </div>
      </div>
    </Motion>
  </section>
</template>

<style scoped>
.bento {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

@media (min-width: 640px) {
  .bento {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .bento-hero,
  .bento-wide {
    grid-column: span 2;
  }
}

@media (min-width: 1024px) {
  .bento {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: 1fr;
  }
  .bento-hero {
    grid-column: span 2;
    grid-row: span 2;
  }
  .bento-wide {
    grid-column: span 2;
  }
}
</style>
