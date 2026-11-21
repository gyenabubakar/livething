<script setup lang="ts">
// Moving off Cloudflare: what carries over, what you change, and the core of
// the change as a diff.
type Line = { kind: ' ' | '-' | '+', text: string }

const files: { name: string, lines: Line[] }[] = [
  {
    name: 'chat.ts',
    lines: [
      { kind: ' ', text: 'const base = server({' },
      { kind: '-', text: '  hibernation: { enabled: true },' },
      { kind: ' ', text: '  capabilities: [emits({ message: t<Message>() })],' },
      { kind: ' ', text: '})' },
    ],
  },
  {
    name: 'worker.ts → server.ts',
    lines: [
      { kind: '-', text: 'import { bind } from \'@livething/server-cloudflare\'' },
      { kind: '+', text: 'import { setup } from \'@livething/server-node\'' },
      { kind: ' ', text: 'import { chat } from \'@monorepo/server/chat\'' },
      { kind: ' ', text: '' },
      { kind: '-', text: 'export class ChatRoom extends bind(chat) {}' },
      { kind: '+', text: 'const { bind, ready } = setup()' },
      { kind: '+', text: 'const chatEndpoint = bind(chat, {' },
      { kind: '+', text: '  sql: \'./data/chat.sqlite\',' },
      { kind: '+', text: '})' },
    ],
  },
]

const tone = {
  ' ': 'text-zinc-400',
  '-': 'bg-red-500/10 text-red-300',
  '+': 'bg-emerald-500/10 text-emerald-300',
}

const moves = [
  'Handlers written against ctx, channels, requests and streams',
  'The client, and every type it gets from your server',
  'Your data, which is plain SQLite you can export with an admin method',
]
const changes = [
  'The adapter file and the Worker that routes to it',
  'Any code of yours that uses Cloudflare directly: bindings through ctx.platform, KV, R2, jurisdictions or the hibernation flag',
]
</script>

<template>
  <section class="frame-row grid lg:grid-cols-2">
    <div class="flex flex-col justify-center px-6 sm:px-10 py-16 lg:border-r border-default">
      <p class="section-label">
        No lock-in
      </p>
      <h2 class="section-title">
        Leave whenever you want<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-lg text-base/7 text-muted">
        LiveThing is a framework, not a platform. The code you write against its APIs runs on Node, Bun and Deno too. To move, you swap the adapter and refactor only the parts of your app that call Cloudflare themselves.
      </p>
      <div class="mt-8 grid max-w-lg gap-6 text-sm/6 text-muted sm:grid-cols-2">
        <div>
          <p class="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-500">
            Moves as it is
          </p>
          <ul class="space-y-2">
            <li v-for="item in moves" :key="item" class="flex gap-2">
              <UIcon name="i-ph-check" class="mt-1 size-4 shrink-0 text-primary" />
              {{ item }}
            </li>
          </ul>
        </div>
        <div>
          <p class="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-500">
            You change
          </p>
          <ul class="space-y-2">
            <li v-for="item in changes" :key="item" class="flex gap-2">
              <UIcon name="i-ph-pencil-simple" class="mt-1 size-4 shrink-0 text-zinc-500" />
              {{ item }}
            </li>
          </ul>
        </div>
      </div>
      <NuxtLink to="/server/adapters/overview" class="group mt-8 inline-flex w-fit items-center gap-1.5 font-mono text-xs text-primary">
        <span class="border-b border-primary/40 pb-0.5 group-hover:border-primary">See every adapter</span>
        <UIcon name="i-ph-arrow-right" class="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </NuxtLink>
    </div>

    <LandingGrainPanel tone="dusk" class="min-h-[520px] cursor-default">
      <div class="flex size-full flex-col justify-center gap-4 p-6 sm:p-10">
        <div v-for="file in files" :key="file.name" class="border border-white/10 bg-zinc-950/90 font-mono text-[12px] leading-6 shadow-2xl">
          <div class="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-[11px] text-zinc-400">
            <UIcon name="i-vscode-icons-file-type-typescript" class="size-3.5" /> {{ file.name }}
          </div>
          <div class="overflow-x-auto py-2">
            <div class="w-max min-w-full">
              <p v-for="(line, index) in file.lines" :key="index" class="flex whitespace-pre px-4" :class="tone[line.kind]">
                <span class="w-5 shrink-0 select-none opacity-70">{{ line.kind }}</span>{{ line.text || ' ' }}
              </p>
            </div>
          </div>
        </div>
        <p class="font-mono text-[11px] text-orange-100/80">
          + a few lines to hand upgrades to chatEndpoint in your Node server
        </p>
      </div>
    </LandingGrainPanel>
  </section>
</template>
