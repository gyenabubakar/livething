<script setup lang="ts">
import { createTimeline, stagger, steps } from 'animejs'

const files = [
  {
    name: 'chat.ts',
    icon: 'i-vscode-icons-file-type-typescript',
    summary: 'Your server definition. Nothing in it mentions Cloudflare.',
  },
  {
    name: 'worker.ts',
    icon: 'i-vscode-icons-file-type-typescript',
    summary: 'Turns the definition into a Durable Object class and routes each socket to its room.',
  },
  {
    name: 'wrangler.jsonc',
    icon: 'i-vscode-icons-file-type-json',
    summary: 'Binds the class and gives it SQLite storage.',
  },
]
const active = ref(0)

const output = [
  { text: 'Total Upload: 301.52 KiB / gzip: 68.40 KiB', tone: 'text-zinc-400' },
  { text: 'Your Worker has access to the following bindings:', tone: 'text-zinc-400' },
  { text: '- Durable Objects:', tone: 'text-zinc-400' },
  { text: '  - CHAT_ROOM: ChatRoom', tone: 'text-zinc-200' },
  { text: 'Uploaded chat (2.84 sec)', tone: 'text-zinc-200' },
  { text: 'Deployed chat triggers (0.61 sec)', tone: 'text-zinc-200' },
  { text: '  https://chat.your-team.workers.dev', tone: 'text-orange-300' },
]

const terminal = ref<HTMLElement>()

useIllustration(terminal, () => createTimeline({ loop: true, autoplay: false, loopDelay: 800 })
  .add('.t-command', { maxWidth: ['0ch', '20ch'], duration: 1100, ease: steps(20) }, 300)
  .add('.t-line', { opacity: [0, 1], duration: 1, delay: stagger(260) }, 1800)
  .add(['.t-line', '.t-command'], { opacity: 0, duration: 300, ease: 'linear' }, 1800 + output.length * 260 + 3200)
  .add('.t-command', { maxWidth: '0ch', opacity: 1, duration: 1 }, 1800 + output.length * 260 + 3600))
</script>

<template>
  <section class="frame-row grid lg:grid-cols-2">
    <div class="flex flex-col justify-center px-6 sm:px-10 py-16 lg:border-r border-default">
      <p class="section-label">
        Deploy
      </p>
      <h2 class="section-title">
        Three files and one command<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-lg text-base/7 text-muted">
        The Cloudflare adapter turns your server into a Durable Object class. You keep writing the same handlers you would write for Node, and <code class="font-mono text-sm text-primary">wrangler deploy</code> puts them in every Cloudflare city.
      </p>

      <ol class="mt-10 max-w-lg border-t border-default">
        <li v-for="(file, index) in files" :key="file.name" class="border-b border-default">
          <button
            type="button"
            class="flex w-full gap-4 py-4 text-left transition-colors"
            :class="active === index ? 'text-highlighted' : 'text-muted hover:text-toned'"
            @click="active = index"
          >
            <span class="font-mono text-xs" :class="active === index ? 'text-primary' : 'text-dimmed'">0{{ index + 1 }}</span>
            <span>
              <span class="font-mono text-sm">{{ file.name }}</span>
              <span class="mt-1 block text-sm/6 text-muted">{{ file.summary }}</span>
            </span>
          </button>
        </li>
      </ol>
      <NuxtLink to="/core/runtimes/adapters/cloudflare" class="group mt-8 inline-flex w-fit items-center gap-1.5 font-mono text-xs text-primary">
        <span class="border-b border-primary/40 pb-0.5 group-hover:border-primary">Read the Cloudflare guide</span>
        <UIcon name="i-ph-arrow-right" class="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </NuxtLink>
    </div>

    <LandingGrainPanel class="min-h-[640px] cursor-default">
      <div class="flex size-full flex-col justify-center gap-4 p-6 sm:p-10">
        <div class="border border-white/10 bg-zinc-950/90 font-mono text-[12px] leading-6 shadow-2xl">
          <div class="flex overflow-x-auto border-b border-white/10 text-[11px]" role="tablist">
            <button
              v-for="(file, index) in files"
              :key="file.name"
              type="button"
              role="tab"
              :aria-selected="active === index"
              class="flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 transition-colors"
              :class="active === index ? 'text-zinc-100 shadow-[inset_0_-1px_0_var(--color-orange-400)]' : 'text-zinc-500 hover:text-zinc-300'"
              @click="active = index"
            >
              <UIcon :name="file.icon" class="size-3.5" /> {{ file.name }}
            </button>
          </div>
          <pre v-if="active === 0" class="h-80 overflow-auto px-4 py-3 text-zinc-300"><span class="text-violet-400">import</span> { emits, server, t } <span class="text-violet-400">from</span> <span class="text-emerald-300">'@livething/server'</span>
<span class="text-violet-400">import type</span> { InferClient } <span class="text-violet-400">from</span> <span class="text-emerald-300">'@livething/server'</span>
<span class="text-violet-400">import</span> * <span class="text-violet-400">as</span> v <span class="text-violet-400">from</span> <span class="text-emerald-300">'valibot'</span>

<span class="text-violet-400">const</span> base = <span class="text-amber-300">server</span>({
  hibernation: <span class="text-orange-300">true</span>,
  capabilities: [
    <span class="text-amber-300">emits</span>({ message: t&lt;{ text: <span class="text-sky-300">string</span>; from: <span class="text-sky-300">string</span> }&gt;() }),
  ],
})

<span class="text-violet-400">const</span> sendMessage = base.<span class="text-amber-300">on</span>(<span class="text-emerald-300">'send-message'</span>, {
  input: v.<span class="text-amber-300">object</span>({ text: v.<span class="text-amber-300">string</span>() }),
  <span class="text-amber-300">run</span>(ctx, input) {
    <span class="text-violet-400">const</span> message = { text: input.text, from: ctx.user.id }
    ctx.<span class="text-amber-300">broadcast</span>(<span class="text-emerald-300">'message'</span>, message, { includeSelf: <span class="text-orange-300">true</span> })
  },
})

<span class="text-violet-400">export const</span> chat = base.<span class="text-amber-300">assemble</span>({ handlers: [sendMessage] })
<span class="text-violet-400">export type</span> ChatSocket = InferClient&lt;<span class="text-violet-400">typeof</span> chat&gt;</pre>
          <pre v-else-if="active === 1" class="h-80 overflow-auto px-4 py-3 text-zinc-300"><span class="text-violet-400">import</span> { bind } <span class="text-violet-400">from</span> <span class="text-emerald-300">'@livething/server-cloudflare'</span>
<span class="text-violet-400">import</span> { chat } <span class="text-violet-400">from</span> <span class="text-emerald-300">'@monorepo/server/chat'</span>

<span class="text-zinc-500">// One Durable Object class; Cloudflare runs one copy per room.</span>
<span class="text-violet-400">export class</span> <span class="text-sky-300">ChatRoom</span> <span class="text-violet-400">extends</span> <span class="text-amber-300">bind</span>(chat) {}

<span class="text-violet-400">export default</span> {
  <span class="text-amber-300">fetch</span>(request, env) {
    <span class="text-violet-400">const</span> room = <span class="text-violet-400">new</span> <span class="text-amber-300">URL</span>(request.url).searchParams.<span class="text-amber-300">get</span>(<span class="text-emerald-300">'room'</span>) ?? <span class="text-emerald-300">'lobby'</span>
    <span class="text-violet-400">const</span> id = env.CHAT_ROOM.<span class="text-amber-300">idFromName</span>(room)
    <span class="text-violet-400">return</span> env.CHAT_ROOM.<span class="text-amber-300">get</span>(id).<span class="text-amber-300">fetch</span>(request)
  },
} <span class="text-violet-400">satisfies</span> <span class="text-sky-300">ExportedHandler</span>&lt;<span class="text-sky-300">Env</span>&gt;</pre>
          <pre v-else class="h-80 overflow-auto px-4 py-3 text-zinc-300">{
  <span class="text-sky-300">"name"</span>: <span class="text-emerald-300">"chat"</span>,
  <span class="text-sky-300">"main"</span>: <span class="text-emerald-300">"src/worker.ts"</span>,
  <span class="text-sky-300">"compatibility_date"</span>: <span class="text-emerald-300">"2026-04-07"</span>,
  <span class="text-sky-300">"compatibility_flags"</span>: [<span class="text-emerald-300">"nodejs_compat"</span>],
  <span class="text-sky-300">"durable_objects"</span>: {
    <span class="text-sky-300">"bindings"</span>: [
      { <span class="text-sky-300">"name"</span>: <span class="text-emerald-300">"CHAT_ROOM"</span>, <span class="text-sky-300">"class_name"</span>: <span class="text-emerald-300">"ChatRoom"</span> }
    ]
  },
  <span class="text-sky-300">"migrations"</span>: [
    { <span class="text-sky-300">"tag"</span>: <span class="text-emerald-300">"v1"</span>, <span class="text-sky-300">"new_sqlite_classes"</span>: [<span class="text-emerald-300">"ChatRoom"</span>] }
  ]
}</pre>
        </div>

        <div ref="terminal" class="border border-white/10 bg-zinc-950/90 font-mono text-[12px] leading-6 shadow-2xl">
          <div class="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
            <span v-for="dot in 3" :key="dot" class="size-2 rounded-full bg-zinc-700" />
            <span class="ml-3 text-[11px] text-zinc-500">terminal</span>
          </div>
          <div class="h-60 overflow-x-auto px-4 py-3">
            <p class="flex text-zinc-200">
              <span class="text-orange-400">$&nbsp;</span>
              <span class="t-command inline-block overflow-hidden whitespace-nowrap" style="max-width: 20ch">pnpm wrangler deploy</span>
            </p>
            <p v-for="line in output" :key="line.text" class="t-line rm-show whitespace-pre opacity-0" :class="line.tone">
              {{ line.text }}
            </p>
          </div>
        </div>
      </div>
    </LandingGrainPanel>
  </section>
</template>
