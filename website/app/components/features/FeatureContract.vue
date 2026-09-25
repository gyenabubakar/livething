<script setup lang="ts">
import { Motion } from 'motion-v'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'InferClient', icon: 'i-ph-magic-wand-duotone' },
  { label: 'Perspective flip', icon: 'i-ph-arrows-left-right-duotone' },
  { label: 'Compile-time safe', icon: 'i-ph-shield-check-duotone' },
]
</script>

<template>
  <section class="deferred-section pt-16 md:pt-20 pb-24 md:pb-32">
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
          <div aria-hidden="true" v-play-when-visible class="absolute inset-0 section-title max-w-2xl blur-xs animate-pulse pointer-events-none">
            <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
          </div>
        </div>
        <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-toned [&_code]:font-mono [&_code]:text-primary [&_code]:bg-elevated/60 [&_code]:px-1">
          <slot name="description" mdc-unwrap="p" />
        </p>
        <div class="mt-5 flex flex-wrap gap-2">
          <span
            v-for="pill in pills"
            :key="pill.label"
            class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-toned"
          >
            <UIcon :name="pill.icon" class="size-3.5 text-emerald-400" />
            {{ pill.label }}
          </span>
        </div>
        <NuxtLink v-if="props.link" :to="props.link" class="mt-4 group inline-flex items-center gap-1.5 font-mono text-xs text-primary transition-colors">
          <span class="border-b border-primary/50 pb-0.5 transition-colors group-hover:border-primary">{{ props.linkLabel || 'Learn more' }}</span>
          <UIcon name="i-ph-arrow-right-duotone" class="size-4 transition-transform group-hover:translate-x-0.5" />
        </NuxtLink>
      </div>
    </Motion>

    <div class="grid gap-6 lg:grid-cols-2 *:min-w-0 items-stretch">
      <!-- Left: the server contract -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.1 }"
        :in-view-options="{ once: true }"
        class="block"
      >
        <div class="h-full overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">chat.server.ts</span>
          </div>
          <div class="p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> base = <span class="text-amber-400">server</span>({
  <span class="text-sky-400">capabilities</span>: [
    <span class="text-amber-400">emits</span>({ <span class="text-sky-400">message</span>: <span class="text-amber-400">t</span>&lt;{ text: <span class="text-sky-400">string</span>; from: <span class="text-sky-400">string</span> }&gt;() }),
  ],
})

<span class="text-violet-400">const</span> handleSend = base.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'send-message'</span>, {
  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ text: v.<span class="text-amber-400">string</span>(), from: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">run</span>: (ctx, msg) => ctx.<span class="text-amber-400">broadcast</span>(<span class="text-emerald-400">'message'</span>, msg),
})

<span class="text-violet-400">export const</span> definition = base.<span class="text-amber-400">assemble</span>({ <span class="text-sky-400">handlers</span>: [handleSend] })

<span class="block -mx-6 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.5rem-2px)] pr-6"><span class="text-dimmed">// the whole client API — one line, no codegen</span>
<span class="text-violet-400">export type</span> <span class="text-sky-400">ChatSocket</span> = <span class="text-amber-400">InferClient</span>&lt;<span class="text-violet-400">typeof</span> definition&gt;</span></code></pre>
          </div>
        </div>
      </Motion>

      <!-- Right: one client file — the contract holding, and the compiler catching a typo -->
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.2 }"
        :in-view-options="{ once: true }"
        class="h-full"
      >
        <div class="h-full flex flex-col overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-sky-300">
              <span class="size-1.5 rounded-full bg-sky-400" /> client
            </span>
            <span class="font-mono text-xs text-toned">app.client.ts</span>
            <span class="ml-auto inline-flex items-center gap-3 font-mono text-[11px]">
              <span class="inline-flex items-center gap-1.5 text-emerald-400"><span class="size-1.5 rounded-full bg-emerald-400" /> inferred</span>
              <span class="inline-flex items-center gap-1.5 text-red-400"><span class="size-1.5 rounded-full bg-red-400" /> caught</span>
            </span>
          </div>
          <div class="flex-1 flex flex-col justify-center p-6 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">import type</span> { <span class="text-sky-400">ChatSocket</span> } <span class="text-violet-400">from</span> <span class="text-emerald-400">'@chat/server'</span>
<span class="block -mx-6 border-l-2 border-sky-500/70 bg-sky-500/10 pl-[calc(1.5rem-2px)] pr-6"><span class="text-violet-400">const</span> socket = <span class="text-amber-400">client</span>&lt;<span class="text-sky-400">ChatSocket</span>&gt;()(<span class="text-amber-400">connect</span>(url))</span>
socket.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'message'</span>, (msg) => {
  msg.text   <span class="text-dimmed">// string</span>
  msg.from   <span class="text-dimmed">// string</span>
})
socket.<span class="text-amber-400">send</span>(<span class="text-emerald-400">'send-message'</span>, { text, from }) <span class="text-dimmed">// typed too</span>

socket.<span class="text-amber-400">on</span>(<span class="text-red-400 underline decoration-wavy decoration-red-500 underline-offset-4">'mesage'</span>, (msg) => {})</code></pre>
            <div class="mt-3 border-l-2 border-red-500/40 pl-3">
              <p class="text-xs text-red-400/90 leading-relaxed">
                Argument of type <span class="text-red-300">'mesage'</span> is not assignable to parameter of type <span class="text-red-300">'message'</span>.
              </p>
            </div>
            <div class="mt-4 space-y-1 border-t border-muted pt-3">
              <p class="text-xs text-toned">
                <span class="text-emerald-400">&#10003;</span> Inferred from the server — every event and field typed
              </p>
              <p class="text-xs text-toned">
                <span class="text-red-400">&#10007;</span> Rename on the server and stale calls stop compiling
              </p>
            </div>
          </div>
        </div>
      </Motion>
    </div>
  </section>
</template>
