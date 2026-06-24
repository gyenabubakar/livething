<script setup lang="ts">
import { Motion } from 'motion-v'

const prefersReducedMotion = ref(false)
const activeOutput = ref<'typed' | 'typo'>('typed')
const outputRef = ref<HTMLElement>()

let cycleInterval: ReturnType<typeof setInterval> | undefined
let observer: IntersectionObserver | undefined

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'InferClient', icon: 'i-ph-magic-wand-duotone' },
  { label: 'Perspective flip', icon: 'i-ph-arrows-left-right-duotone' },
  { label: 'Compile-time safe', icon: 'i-ph-shield-check-duotone' },
]

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!prefersReducedMotion.value && outputRef.value) {
    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !cycleInterval) {
          cycleInterval = setInterval(() => {
            activeOutput.value = activeOutput.value === 'typed' ? 'typo' : 'typed'
          }, 6500)
        }
      },
      { threshold: 0.3 },
    )
    observer.observe(outputRef.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (cycleInterval) clearInterval(cycleInterval)
})

function setOutput(type: 'typed' | 'typo') {
  activeOutput.value = type
  if (cycleInterval) {
    clearInterval(cycleInterval)
    cycleInterval = undefined
  }
}
</script>

<template>
  <section class="pt-16 md:pt-20 pb-24 md:pb-32">
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5 }"
      :in-view-options="{ once: true }"
      class="mb-10"
    >
      <div>
        <p v-if="$slots.headline" class="section-label">
          <slot name="headline" mdc-unwrap="p" />
        </p>
        <div class="relative mb-5">
          <h2 class="section-title max-w-2xl">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </h2>
          <div aria-hidden="true" class="absolute inset-0 section-title max-w-2xl blur-xs animate-pulse pointer-events-none">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </div>
        </div>
        <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-muted">
          <slot name="description" mdc-unwrap="p" />
        </p>
        <div class="mt-5 flex flex-wrap gap-2">
          <span
            v-for="pill in pills"
            :key="pill.label"
            class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-muted"
          >
            <UIcon :name="pill.icon" class="size-3 text-emerald-500" />
            {{ pill.label }}
          </span>
        </div>
        <NuxtLink v-if="props.link" :to="props.link" class="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-dimmed hover:text-primary transition-colors">
          {{ props.linkLabel || 'Learn more' }}
          <UIcon name="i-ph-arrow-right-duotone" class="size-3" />
        </NuxtLink>
      </div>
    </Motion>

    <div class="grid gap-6 lg:grid-cols-2 *:min-w-0">
      <!-- Left: the server contract, inferred to the client -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.1 }"
        :in-view-options="{ once: true }"
      >
        <div class="h-full overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
            <div class="flex gap-1.5">
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
            </div>
            <span class="ml-3 font-mono text-xs text-dimmed">chat.ts</span>
            <span class="ml-auto font-mono text-[10px] text-dimmed">server</span>
          </div>
          <div class="p-5 font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> base = <span class="text-amber-400">define</span>({
  <span class="text-sky-400">env</span>: <span class="text-amber-400">t</span>&lt;<span class="text-sky-400">Env</span>&gt;(),
  <span class="text-sky-400">capabilities</span>: [
    <span class="text-amber-400">emits</span>({ <span class="text-sky-400">message</span>: <span class="text-amber-400">t</span>&lt;{ text: <span class="text-sky-400">string</span>; from: <span class="text-sky-400">string</span> }&gt;() }),
  ],
})

<span class="text-violet-400">export const</span> handler = base.<span class="text-amber-400">assemble</span>(
  base.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'send-message'</span>, {
    <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ text: v.<span class="text-amber-400">string</span>(), from: v.<span class="text-amber-400">string</span>() }),
    <span class="text-sky-400">run</span>: (ctx, msg) => ctx.<span class="text-amber-400">broadcast</span>(<span class="text-emerald-400">'message'</span>, msg),
  }),
)

<span class="text-dimmed">// The whole client API — one line, no codegen.</span>
<span class="text-violet-400">export type</span> <span class="text-sky-400">ChatSocket</span> = <span class="text-amber-400">InferClient</span>&lt;<span class="text-violet-400">typeof</span> handler&gt;</code></pre>
          </div>
        </div>
      </Motion>

      <!-- Right: the client side, with the compiler catching drift -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.2 }"
        :in-view-options="{ once: true }"
      >
        <div ref="outputRef" class="h-full overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
            <div class="flex gap-1.5">
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
            </div>
            <span class="ml-3 font-mono text-xs text-dimmed">app.ts</span>
            <div class="ml-auto flex items-center gap-1.5">
              <button
                class="font-mono text-[10px] px-2 py-0.5 border transition-all duration-300 outline-none cursor-pointer"
                :class="activeOutput === 'typed'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  : 'border-transparent text-dimmed hover:text-muted'"
                @click="setOutput('typed')"
              >
                'message'
              </button>
              <button
                class="font-mono text-[10px] px-2 py-0.5 border transition-all duration-300 outline-none cursor-pointer"
                :class="activeOutput === 'typo'
                  ? 'border-red-500/30 bg-red-500/10 text-red-500'
                  : 'border-transparent text-dimmed hover:text-muted'"
                @click="setOutput('typo')"
              >
                'mesage'
              </button>
            </div>
          </div>

          <!-- Stacked outputs — grid trick for stable height -->
          <div class="grid [&>*]:col-start-1 [&>*]:row-start-1">
            <!-- Typed: the contract holds -->
            <div
              class="p-5 font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto transition-opacity duration-300"
              :class="activeOutput === 'typed' ? 'opacity-100' : 'opacity-0 pointer-events-none'"
            >
              <pre><code>socket.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'message'</span>, (msg) => {
  msg.text   <span class="text-dimmed">// string</span>
  msg.from   <span class="text-dimmed">// string</span>
})

socket.<span class="text-amber-400">send</span>(<span class="text-emerald-400">'send-message'</span>, {
  text: <span class="text-emerald-400">'hi'</span>, from: <span class="text-emerald-400">'gyen'</span>,
})</code></pre>
              <div class="mt-4 border-t border-muted pt-3">
                <p class="text-xs text-dimmed">
                  <span class="text-emerald-500">&#10003;</span> Inferred from the server — every event and field typed
                </p>
              </div>
            </div>

            <!-- Typo: the compiler catches it -->
            <div
              class="p-5 font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto transition-opacity duration-300"
              :class="activeOutput === 'typo' ? 'opacity-100' : 'opacity-0 pointer-events-none'"
            >
              <pre><code>socket.<span class="text-amber-400">on</span>(<span class="text-red-400 underline decoration-wavy decoration-red-500 underline-offset-4">'mesage'</span>, (msg) => {
  msg.text
})</code></pre>
              <div class="mt-4 border-l-2 border-red-500/40 pl-3">
                <p class="text-xs text-red-400/90 leading-relaxed">
                  Argument of type <span class="text-red-300">'mesage'</span> is not assignable to parameter of type <span class="text-red-300">'message' | 'user-joined'</span>.
                </p>
              </div>
              <div class="mt-4 border-t border-muted pt-3">
                <p class="text-xs text-dimmed">
                  <span class="text-red-500">&#10007;</span> Rename on the server and stale calls stop compiling
                </p>
              </div>
            </div>
          </div>
        </div>
      </Motion>
    </div>
  </section>
</template>
