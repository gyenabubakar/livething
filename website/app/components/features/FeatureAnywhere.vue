<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Frames in, frames out', icon: 'i-ph-arrows-down-up-duotone' },
  { label: 'Text and binary', icon: 'i-ph-binary-duotone' },
  { label: 'Adapters own the transport', icon: 'i-ph-plug-duotone' },
]

const transports = ['WebSocket', 'Server-sent events', 'Long polling', 'Anything you write']
const runtimes = ['Cloudflare', 'Node', 'Bun', 'Deno']
const frames = ['{"t":"send-message",…}', '‹binary · 1.4 KB›']

const swap = ref(0)
const transport = computed(() => transports[swap.value]!)
const runtime = computed(() => runtimes[(swap.value + 2) % runtimes.length]!)
const frame = computed(() => frames[swap.value % frames.length]!)

type Leg = 'in-1' | 'in-2' | 'handle' | 'out-1' | 'out-2' | 'idle'
const leg = ref<Leg>('in-1')

const legStatus: Record<Leg, string> = {
  'in-1': 'client → adapter',
  'in-2': 'adapter → engine',
  'handle': 'engine: your handler runs',
  'out-1': 'engine → adapter',
  'out-2': 'adapter → client',
  'idle': 'adapter swapped',
}

function resetSpine() {
  leg.value = 'in-1'
}

const spineEvents: TimedEvent[] = [
  { at: 950, run: () => { leg.value = 'in-2' } },
  { at: 1900, run: () => { leg.value = 'handle' } },
  { at: 2700, run: () => { leg.value = 'out-1' } },
  { at: 3650, run: () => { leg.value = 'out-2' } },
  { at: 4600, run: () => {
    leg.value = 'idle'
    swap.value = (swap.value + 1) % transports.length
  } },
]

const adapters = [
  { name: 'Cloudflare', slug: 'cloudflare' },
  { name: 'Node', slug: 'node' },
  { name: 'Bun', slug: 'bun' },
  { name: 'Deno', slug: 'deno' },
]

const current = ref(0)
const active = computed(() => adapters[current.value]!)

function resetRuntime() {
  current.value = 0
}

const runtimeEvents: TimedEvent[] = [
  { at: 1900, run: () => { current.value = 1 } },
  { at: 3800, run: () => { current.value = 2 } },
  { at: 5700, run: () => { current.value = 3 } },
]

const prefersReducedMotion = ref(false)
const spineRef = ref<HTMLElement>()
const runtimeRef = ref<HTMLElement>()
const spineSeq = useTimedSequence({ events: spineEvents, totalDuration: 5600, loop: true, onReset: resetSpine })
const runtimeSeq = useTimedSequence({ events: runtimeEvents, totalDuration: 7600, loop: true, onReset: resetRuntime })

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

useViewportActivation(spineRef, {
  threshold: 0.25,
  disabled: prefersReducedMotion,
  onEnter: () => {
    spineSeq.start()
    spineSeq.resume()
  },
  onExit: spineSeq.pause,
})

useViewportActivation(runtimeRef, {
  threshold: 0.25,
  disabled: prefersReducedMotion,
  onEnter: () => {
    runtimeSeq.start()
    runtimeSeq.resume()
  },
  onExit: runtimeSeq.pause,
})
</script>

<template>
  <section class="deferred-section pt-16 pb-24 md:pt-20 md:pb-32">
    <div class="grid items-stretch gap-8 *:min-w-0 lg:grid-cols-2 lg:gap-12">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
      >
        <div>
          <p v-if="$slots.headline" class="section-label">
            <slot name="headline" mdc-unwrap="p" />
          </p>
          <div class="relative mb-5">
            <h2 class="section-title max-w-xl">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </h2>
            <div aria-hidden="true" v-play-when-visible class="pointer-events-none absolute inset-0 section-title max-w-xl animate-pulse blur-xs">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </div>
          </div>
          <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-toned [&_code]:border [&_code]:border-muted [&_code]:bg-elevated/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-primary">
            <slot name="description" mdc-unwrap="p" />
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <span
              v-for="pill in pills"
              :key="pill.label"
              class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-toned"
            >
              <UIcon :name="pill.icon" class="size-3.5 text-emerald-400" />
              {{ pill.label }}
            </span>
          </div>
          <NuxtLink v-if="props.link" :to="props.link" class="group mt-6 inline-flex items-center gap-1.5 font-mono text-xs text-primary transition-colors">
            <span class="border-b border-primary/50 pb-0.5 transition-colors group-hover:border-primary">{{ props.linkLabel || 'Learn more' }}</span>
            <UIcon name="i-ph-arrow-right-duotone" class="size-4 transition-transform group-hover:translate-x-0.5" />
          </NuxtLink>
        </div>
      </Motion>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.15 }"
        :in-view-options="{ once: true }"
        class="h-full"
      >
        <div ref="spineRef" class="flex h-full flex-col overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <UIcon name="i-ph-path-duotone" class="size-4 shrink-0 text-primary" />
            <span class="font-mono text-xs text-toned">one frame, end to end</span>
            <span class="ml-auto font-mono text-[11px] text-primary transition-colors duration-300">{{ legStatus[leg] }}</span>
          </div>

          <div class="flex flex-1 flex-col justify-center gap-5 p-5">
            <div class="spine-grid grid grid-cols-1 items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:gap-2.5">
              <div class="flex items-center gap-2 sm:block sm:text-center">
                <UIcon name="i-ph-devices-duotone" class="size-6 shrink-0 text-sky-300 sm:mx-auto" />
                <div class="sm:mt-1.5">
                  <div class="font-mono text-[11px] text-toned">client</div>
                  <div class="font-mono text-[10px] text-dimmed">browser · native</div>
                </div>
              </div>

              <div class="relative h-7 overflow-hidden">
                <div class="absolute inset-x-0 top-1/2 h-px bg-muted/50" />
                <div
                  class="wire-flow absolute inset-x-0 top-1/2 h-0.5 -translate-y-px transition-opacity duration-200"
                  :class="leg === 'in-1' || leg === 'out-2' ? 'opacity-100' : 'opacity-0'"
                />
                <div
                  v-if="leg === 'in-1' || leg === 'out-2'"
                  v-play-when-visible
                  :class="leg === 'in-1' ? 'parcel-fwd' : 'parcel-rev'"
                  class="absolute top-1/2 size-2 -translate-y-1/2 bg-primary"
                />
              </div>

              <div class="border border-primary/50 bg-primary/[0.07] px-3 py-2 text-center transition-colors duration-300">
                <UIcon name="i-ph-plug-duotone" class="mx-auto size-5 text-primary" />
                <div class="mt-1.5 font-mono text-[11px] text-toned">adapter</div>
                <div class="font-mono text-[10px] text-primary transition-colors duration-300">{{ transport }}</div>
                <div class="font-mono text-[10px] text-dimmed transition-colors duration-300">on {{ runtime }}</div>
              </div>

              <div class="relative h-7 overflow-hidden">
                <div class="absolute inset-x-0 top-1/2 h-px bg-muted/50" />
                <div
                  class="wire-flow absolute inset-x-0 top-1/2 h-0.5 -translate-y-px transition-opacity duration-200"
                  :class="leg === 'in-2' || leg === 'out-1' ? 'opacity-100' : 'opacity-0'"
                />
                <div
                  v-if="leg === 'in-2' || leg === 'out-1'"
                  v-play-when-visible
                  :class="leg === 'in-2' ? 'parcel-fwd' : 'parcel-rev'"
                  class="absolute top-1/2 -translate-y-1/2 whitespace-nowrap border border-primary/50 bg-default px-1.5 py-0.5 font-mono text-[10px] text-primary"
                >{{ frame }}</div>
              </div>

              <div
                class="border border-emerald-400/40 bg-emerald-500/[0.06] px-3 py-2 text-center transition-colors duration-300"
                :class="leg === 'handle' ? 'border-emerald-400/80' : ''"
              >
                <UIcon name="i-ph-cpu-duotone" class="mx-auto size-5 text-emerald-300" />
                <div class="mt-1.5 font-mono text-[11px] text-toned">WSKit engine</div>
                <div class="font-mono text-[10px] text-dimmed">contract · handlers</div>
                <div class="font-mono text-[10px] text-emerald-300">unchanged</div>
              </div>
            </div>

            <div class="border-t border-muted/60 pt-4">
              <div class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-dimmed">
                <span class="size-1 bg-primary" /> the middle swaps freely
              </div>
              <div class="mt-2.5 space-y-2">
                <div class="flex items-baseline gap-3">
                  <span class="w-16 shrink-0 font-mono text-[11px] text-dimmed">transport</span>
                  <div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    <span
                      v-for="item in transports"
                      :key="item"
                      class="border px-2 py-0.5 font-mono text-[11px] transition-colors duration-300"
                      :class="transport === item ? 'border-primary/60 bg-primary/10 text-primary' : 'border-muted bg-elevated/30 text-dimmed'"
                    >{{ item }}</span>
                  </div>
                </div>
                <div class="flex items-baseline gap-3">
                  <span class="w-16 shrink-0 font-mono text-[11px] text-dimmed">runtime</span>
                  <div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    <span
                      v-for="item in runtimes"
                      :key="item"
                      class="border px-2 py-0.5 font-mono text-[11px] transition-colors duration-300"
                      :class="runtime === item ? 'border-primary/60 bg-primary/10 text-primary' : 'border-muted bg-elevated/30 text-dimmed'"
                    >{{ item }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2 border-t border-muted/60 px-4 py-3 font-mono text-[11px] text-toned">
            <UIcon name="i-ph-shield-check-duotone" class="size-4 shrink-0 text-emerald-400" />
            the middle swaps; the engine only ever sees a frame
          </div>
        </div>
      </Motion>
    </div>

    <div class="mt-20 md:mt-24">
      <div class="grid items-stretch gap-8 *:min-w-0 lg:grid-cols-2 lg:gap-12">
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5 }"
          :in-view-options="{ once: true }"
        >
          <div class="flex h-full flex-col justify-center">
            <p class="section-label">Runs anywhere</p>
            <h3 class="mt-4 text-2xl font-semibold tracking-tight text-highlighted md:text-3xl">
              Your infra, any runtime<span class="text-primary">.</span>
            </h3>
            <p class="mt-5 max-w-xl text-sm leading-relaxed text-toned">
              Because the engine only ever sees a frame, the same typed handler runs on Cloudflare Durable Objects, Node, Bun, or Deno — swap one import and your contract, handlers, and client stay identical. No hosted service to rent, no runtime lock-in.
            </p>
          </div>
        </Motion>

        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.15 }"
          :in-view-options="{ once: true }"
          class="h-full"
        >
          <div ref="runtimeRef" class="flex h-full flex-col overflow-hidden border border-muted bg-default">
            <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
              <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
                <span class="size-1.5 rounded-full bg-emerald-400" /> server
              </span>
              <span class="font-mono text-xs text-toned">room.server.ts</span>
            </div>
            <div class="flex flex-1 flex-col justify-center overflow-x-auto p-5 font-mono text-xs leading-loose sm:text-sm">
              <pre class="min-h-[10em]"><code><span class="text-dimmed">// only the runtime entry changes</span>
<span v-if="active.slug === 'cloudflare'"><span class="text-violet-400">import</span> { bind } <span class="text-violet-400">from</span> <span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-emerald-400">'@wskit/server-</span><span class="text-primary transition-colors duration-300">{{ active.slug }}</span><span class="text-emerald-400">'</span></span></span><span v-else-if="active.slug === 'node'"><span class="text-violet-400">import</span> { setup } <span class="text-violet-400">from</span> <span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-emerald-400">'@wskit/server-</span><span class="text-primary transition-colors duration-300">{{ active.slug }}</span><span class="text-emerald-400">'</span></span></span><span v-else><span class="text-violet-400">import</span> { server } <span class="text-violet-400">from</span> <span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-emerald-400">'@wskit/server-</span><span class="text-primary transition-colors duration-300">{{ active.slug }}</span><span class="text-emerald-400">'</span></span></span>
<span class="text-violet-400">import</span> { chatHandler } <span class="text-violet-400">from</span> <span class="text-emerald-400">'./chat'</span>

<span v-if="active.slug === 'cloudflare'" class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-violet-400">export class</span>&nbsp;ChatRoom&nbsp;<span class="text-violet-400">extends</span>&nbsp;<span class="text-amber-400">bind</span>(chatHandler) {}</span><template v-else-if="active.slug === 'node'"><span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-violet-400">const</span>&nbsp;wskit = <span class="text-amber-400">setup</span>()</span>
<span class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-violet-400">const</span>&nbsp;chat = wskit.<span class="text-amber-400">bind</span>(chatHandler, {})</span></template><span v-else class="inline-flex items-center border border-primary/40 bg-primary/10 px-1 transition-colors duration-300"><span class="text-violet-400">const</span>&nbsp;service = <span class="text-amber-400">server</span>(chatHandler, { <span class="text-sky-400">port</span>: <span class="text-amber-400">3000</span> })</span></code></pre>
            </div>
          </div>
        </Motion>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wire-flow {
  background-image: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-color-primary-500) 90%, transparent) 0 4px,
    transparent 4px 12px
  );
  background-size: 12px 100%;
  animation: wire-move 0.5s linear infinite;
}

@keyframes wire-move {
  to {
    background-position: 12px 0;
  }
}

@media (min-width: 640px) {
  .spine-grid {
    grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr) auto;
  }
}

.parcel-fwd,
.parcel-rev {
  animation-duration: 0.95s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: 1;
  animation-fill-mode: both;
}

.parcel-fwd {
  animation-name: parcel-fwd;
}

.parcel-rev {
  animation-name: parcel-rev;
}

@keyframes parcel-fwd {
  from {
    left: 0;
    transform: translate(-50%, -50%);
  }
  to {
    left: 100%;
    transform: translate(-50%, -50%);
  }
}

@keyframes parcel-rev {
  from {
    left: 100%;
    transform: translate(-50%, -50%);
  }
  to {
    left: 0;
    transform: translate(-50%, -50%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wire-flow,
  .parcel-fwd,
  .parcel-rev {
    animation: none;
  }

  .parcel-fwd,
  .parcel-rev {
    left: 50%;
    transform: translate(-50%, -50%);
  }
}
</style>
