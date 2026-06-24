<script setup lang="ts">
const rootRef = ref<HTMLElement>()
const started = ref(false)
const revealed = ref(0)
let viewportObserver: IntersectionObserver | undefined
let timers: ReturnType<typeof setTimeout>[] = []

// Server-side runtimes (Cloudflare ships today; Node/Bun/Deno adapters are on the roadmap).
const serverSide = [
  { label: 'Durable Object', icon: 'i-logos-cloudflare-icon', sublabel: 'Cloudflare edge' },
  { label: 'Node.js', icon: 'i-logos-nodejs-icon', sublabel: 'Server · CLI' },
  { label: 'Bun', icon: 'i-logos-bun', sublabel: 'Fast runtime' },
  { label: 'Deno', icon: 'i-logos-deno', sublabel: 'Secure runtime' },
]

// App clients — anywhere with a WebSocket.
const clientSide = [
  { label: 'Browser', icon: 'i-ph-globe-duotone', sublabel: 'React · Vue · Svelte', iconClass: 'text-dimmed' },
  { label: 'React Native', icon: 'i-logos-react', sublabel: 'iOS · Android', iconClass: '' },
]

type Kind = 'event' | 'request' | 'stream' | 'channel'

// One coherent, readable exchange — every WSKit message kind, both directions.
// dir 'out' = client → server (server is on the left, so it travels leftward).
const steps: { dir: 'out' | 'in', name: string, type: string, kind: Kind }[] = [
  { dir: 'out', name: 'join', type: '"general"', kind: 'channel' },
  { dir: 'in', name: 'user-joined', type: '{ name }', kind: 'channel' },
  { dir: 'out', name: 'send-message', type: '{ text }', kind: 'event' },
  { dir: 'in', name: 'message', type: '{ text, from }', kind: 'event' },
  { dir: 'out', name: 'ask-ai', type: '{ prompt }', kind: 'request' },
  { dir: 'in', name: 'chunk', type: '{ token }', kind: 'stream' },
  { dir: 'in', name: 'chunk', type: '{ token }', kind: 'stream' },
]

const kindClass: Record<Kind, string> = {
  event: 'text-sky-300 border-sky-500/40 bg-sky-500/[0.08]',
  request: 'text-violet-300 border-violet-500/40 bg-violet-500/[0.08]',
  stream: 'text-amber-300 border-amber-500/40 bg-amber-500/[0.08]',
  channel: 'text-pink-300 border-pink-500/40 bg-pink-500/[0.08]',
}

const dotClass: Record<Kind, string> = {
  event: 'bg-sky-400',
  request: 'bg-violet-400',
  stream: 'bg-amber-400',
  channel: 'bg-pink-400',
}

const legend: { kind: Kind, label: string }[] = [
  { kind: 'event', label: 'events' },
  { kind: 'request', label: 'requests' },
  { kind: 'stream', label: 'streams' },
  { kind: 'channel', label: 'channels' },
]

function play() {
  revealed.value = 0
  steps.forEach((_, i) => {
    timers.push(setTimeout(() => { revealed.value = i + 1 }, 450 + i * 700))
  })
}

onMounted(() => {
  const root = rootRef.value
  if (!root) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  viewportObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return
      viewportObserver?.disconnect()
      started.value = true
      if (reduce) revealed.value = steps.length
      else play()
    },
    { rootMargin: '120px 0px', threshold: 0 },
  )
  viewportObserver.observe(root)
})

onUnmounted(() => {
  viewportObserver?.disconnect()
  timers.forEach(clearTimeout)
})
</script>

<template>
  <div ref="rootRef" class="w-full max-w-7xl mx-auto px-4" :class="{ started }">
    <div class="grid grid-cols-1 lg:grid-cols-[180px_1fr_180px] gap-0 items-center">
      <!-- Server-side runtimes -->
      <div class="hidden lg:flex flex-col items-end gap-3 justify-center">
        <div v-for="(s, idx) in serverSide" :key="s.label" class="flex items-center gap-0">
          <div class="flex items-center gap-2 px-3 py-2.5 bg-default border border-muted font-mono text-[10px] shrink-0 w-[150px]">
            <UIcon :name="s.icon" class="size-4 shrink-0" />
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-[11px] text-highlighted truncate">{{ s.label }}</span>
              <span class="text-[9px] text-muted truncate">{{ s.sublabel }}</span>
            </div>
          </div>
          <div class="w-5 h-px bg-muted relative overflow-hidden">
            <div class="pulse-inward-right h-full" :style="{ animationDelay: `${idx * 0.4}s` }" />
          </div>
        </div>
      </div>

      <!-- The live typed connection -->
      <div class="mask-b-from-95%">
        <div class="terminal-container overflow-hidden bg-default shadow-2xl shadow-black/60">
          <div class="flex items-center border-b border-muted/30 px-5 py-3">
            <div class="flex gap-1.5">
              <div class="size-2.5 rounded-full bg-muted border border-accented/40" />
              <div class="size-2.5 rounded-full bg-muted border border-accented/40" />
              <div class="size-2.5 rounded-full bg-muted border border-accented/40" />
            </div>
            <div class="flex-1 flex justify-center">
              <span class="font-mono text-[10px] tracking-wider text-dimmed">wss://chat.wskit.dev</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" :class="{ 'animate-pulse': started }" />
              <span class="font-mono text-[9px] text-emerald-500/70 uppercase tracking-wider hidden sm:inline">connected</span>
            </div>
          </div>

          <div class="relative h-[330px] md:h-[360px] overflow-hidden">
            <div class="absolute inset-0 terminal-dots pointer-events-none" />

            <!-- rail headers: server left, client right -->
            <div class="absolute inset-x-0 top-3.5 flex items-center justify-between px-[11%] font-mono text-[10px] uppercase tracking-widest text-muted/80">
              <span class="flex items-center gap-1.5"><UIcon name="i-logos-cloudflare-icon" class="size-3" /> server</span>
              <span class="flex items-center gap-1.5">client <UIcon name="i-ph-devices-duotone" class="size-3" /></span>
            </div>

            <!-- vertical rails -->
            <div class="absolute top-11 bottom-9 left-[13%] w-px bg-linear-to-b from-transparent via-muted to-transparent" />
            <div class="absolute top-11 bottom-9 right-[13%] w-px bg-linear-to-b from-transparent via-muted to-transparent" />

            <!-- exchange ladder -->
            <div class="absolute inset-x-0 top-11 bottom-9 flex flex-col justify-center gap-2.5">
              <div
                v-for="(s, i) in steps"
                :key="`${s.name}-${i}`"
                class="relative h-7 transition-all duration-500"
                :class="i < revealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'"
              >
                <!-- connector -->
                <div class="absolute left-[13%] right-[13%] top-1/2 -translate-y-1/2 h-px bg-muted/50" />
                <!-- arrowhead points at the recipient -->
                <UIcon
                  v-if="s.dir === 'out'"
                  name="i-ph-caret-left-bold"
                  class="absolute left-[12.5%] top-1/2 -translate-y-1/2 size-2.5 text-muted"
                />
                <UIcon
                  v-else
                  name="i-ph-caret-right-bold"
                  class="absolute right-[12.5%] top-1/2 -translate-y-1/2 size-2.5 text-muted"
                />
                <!-- traveling dot -->
                <div
                  v-if="i < revealed"
                  class="absolute top-1/2 -translate-y-1/2 size-1.5 rounded-full"
                  :class="[dotClass[s.kind], s.dir === 'out' ? 'dot-left' : 'dot-right']"
                />
                <!-- readable, static label -->
                <span
                  class="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 px-2.5 py-1 border rounded-xs bg-default font-mono text-[11px] whitespace-nowrap"
                  :class="kindClass[s.kind]"
                >
                  <span class="text-dimmed">{{ s.dir === 'out' ? '←' : '→' }}</span>
                  {{ s.name }}
                  <span class="opacity-65">{{ s.type }}</span>
                </span>
              </div>
            </div>

            <!-- legend -->
            <div class="absolute inset-x-0 bottom-3 flex items-center justify-center gap-4 font-mono text-[9px] text-muted">
              <span v-for="l in legend" :key="l.kind" class="flex items-center gap-1.5">
                <span class="size-1.5 rounded-full" :class="dotClass[l.kind]" />
                {{ l.label }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- App clients -->
      <div class="hidden lg:flex flex-col items-start gap-3 justify-center">
        <div v-for="(c, idx) in clientSide" :key="c.label" class="flex items-center gap-0 w-full">
          <div class="w-5 h-px bg-muted relative overflow-hidden">
            <div class="pulse-inward-left h-full" :style="{ animationDelay: `${idx * 0.4}s` }" />
          </div>
          <div class="flex items-center gap-2 px-3 py-2.5 bg-default border border-muted font-mono text-[10px] shrink-0 w-[150px]">
            <UIcon :name="c.icon" class="size-4 shrink-0" :class="c.iconClass" />
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-[11px] text-highlighted truncate">{{ c.label }}</span>
              <span class="text-[9px] text-muted truncate">{{ c.sublabel }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- guarantees -->
    <div class="hidden lg:flex justify-center gap-3 mt-6 max-w-4xl mx-auto flex-wrap">
      <div
        v-for="g in ['One inferred contract', 'Typed both directions', 'Rename → compile error', 'Autocomplete everywhere']"
        :key="g"
        class="px-3 py-1.5 border border-muted bg-default font-mono text-[10px] text-muted"
      >
        <span class="text-emerald-500 mr-1.5">✓</span>{{ g }}
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes slide-right {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

@keyframes slide-left {
  0% { transform: translateX(100%); }
  100% { transform: translateX(-100%); }
}

.pulse-inward-right {
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-blue-500) 50%, transparent) 50%, transparent 100%);
  animation: slide-right 1.8s linear infinite;
}

.pulse-inward-left {
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-blue-500) 50%, transparent) 50%, transparent 100%);
  animation: slide-left 1.8s linear infinite;
}

.terminal-container {
  border: 1px solid transparent;
  background-image: linear-gradient(var(--ui-bg), var(--ui-bg)), linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.0) 100%);
  background-origin: border-box;
  background-clip: padding-box, border-box;
}

.terminal-dots {
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
  background-size: 20px 20px;
}

/* only the dot moves — the labels stay put and readable */
.dot-left {
  animation: dot-left 1.7s ease-in-out infinite;
}

.dot-right {
  animation: dot-right 1.7s ease-in-out infinite;
}

@keyframes dot-right {
  0% { left: 13%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { left: 87%; opacity: 0; }
}

@keyframes dot-left {
  0% { left: 87%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { left: 13%; opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .pulse-inward-right,
  .pulse-inward-left,
  .dot-left,
  .dot-right {
    animation: none;
  }
}
</style>
