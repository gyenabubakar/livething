<script setup lang="ts">
import { useEventListener } from '@vueuse/core'

// First-party plugins on the roadmap (none ship yet, so each is tagged "coming
// soon"). A pinned list on the left tracks which row is on screen, and clicking
// an entry scrolls to its row. The page scrolls normally the whole time.
const plugins = [
  {
    key: 'chat',
    name: 'Chat',
    icon: 'i-ph-chats-circle-duotone',
    title: 'Rooms, threads and history for a real chat product',
    features: ['Threads and replies', 'Reactions', 'Typing indicators', 'Read state', 'Message history'],
  },
  {
    key: 'push',
    name: 'Push notifications',
    icon: 'i-ph-bell-ringing-duotone',
    title: 'Reach people when their socket is closed',
    features: ['Web push', 'iOS and Android push', 'Sent only when a user is offline', 'Per-user preferences'],
  },
  {
    key: 'collab',
    name: 'Collaboration',
    icon: 'i-ph-pencil-line-duotone',
    title: 'Shared documents that many people edit at once',
    features: ['Conflict-free edits', 'Undo and redo per user', 'Comment threads pinned to the text', 'Offline edits merge on reconnect'],
  },
  {
    key: 'cursors',
    name: 'Live cursors',
    icon: 'i-ph-cursor-click-duotone',
    title: 'See who is here and what they are pointing at',
    features: ['Cursors and selections', 'Follow a user', 'Who is viewing what', 'Smooth, throttled updates'],
  },
  {
    key: 'feed',
    name: 'Notifications feed',
    icon: 'i-ph-tray-arrow-down-duotone',
    title: 'An in-app inbox that stays in sync on every device',
    features: ['Unread counts', 'Mark as read everywhere', 'Grouping', 'Live, or on the next visit'],
  },
  {
    key: 'state',
    name: 'Live state sync',
    icon: 'i-ph-arrows-clockwise-duotone',
    title: 'A typed store that every client shares',
    features: ['Typed from your server', 'Syncs on every change', 'Survives reconnects', 'Validated on the server'],
  },
] as const

const rows = ref<HTMLElement[]>([])
const active = ref(0)
// The current row is the last one whose top has passed a line 30% down the
// screen, so the highlight follows the row being read, not the one coming up.
function track() {
  const line = window.innerHeight * 0.3
  const passed = rows.value.findLastIndex(row => row.getBoundingClientRect().top <= line)
  active.value = Math.max(0, passed)
}

useEventListener('scroll', track, { passive: true })
onMounted(track)

function go(index: number) {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  rows.value[index]?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
}
</script>

<template>
  <section>
    <div class="frame-row px-6 sm:px-10 py-16">
      <p class="section-label">
        First-party plugins
      </p>
      <h2 class="section-title max-w-3xl">
        Speaking of batteries, here are the big ones<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-xl text-base/7 text-muted">
        The features you would otherwise pay a hosted service for, typed end to end and running on your own servers.
      </p>
    </div>

    <div class="frame-row grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <nav class="sticky top-16 self-start p-8 max-md:hidden" aria-label="Plugins">
        <button
          v-for="(plugin, index) in plugins"
          :key="plugin.key"
          type="button"
          class="flex w-full items-center gap-3 py-2 text-left text-sm transition-colors"
          :class="index === active ? 'text-highlighted' : 'text-dimmed hover:text-toned'"
          :aria-current="index === active || undefined"
          @click="go(index)"
        >
          <UIcon :name="plugin.icon" class="size-5 shrink-0" :class="index === active && 'text-primary'" />
          {{ plugin.name }}
        </button>
      </nav>

      <div class="md:border-l border-default">
        <article
          v-for="(plugin, index) in plugins"
          :key="plugin.key"
          :ref="(el) => { if (el) rows[index] = el as HTMLElement }"
          class="grid scroll-mt-16 border-b border-default last:border-b-0 lg:grid-cols-2"
        >
          <div class="flex flex-col justify-center px-6 sm:px-10 py-12">
            <div class="flex items-center gap-3">
              <p class="text-xs font-medium uppercase tracking-widest text-zinc-500">
                {{ plugin.name }}
              </p>
              <span class="border border-default px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">Coming soon</span>
            </div>
            <h3 class="mt-4 text-3xl font-semibold tracking-tight text-highlighted">
              {{ plugin.title }}
            </h3>
            <ul class="mt-6 space-y-2 text-sm text-muted">
              <li v-for="feature in plugin.features" :key="feature" class="flex items-center gap-2">
                <UIcon name="i-ph-check" class="size-4 shrink-0 text-primary" />
                {{ feature }}
              </li>
            </ul>
          </div>

          <LandingGrainPanel :tone="index % 2 ? 'dusk' : 'ember'" class="min-h-80 cursor-default select-none">
            <div class="flex size-full items-center justify-center p-8 font-sans text-[13px] text-zinc-200">
              <!-- Chat -->
              <div v-if="plugin.key === 'chat'" class="w-full max-w-sm space-y-3">
                <div class="w-fit bg-zinc-950/85 px-3 py-2">
                  <p class="text-[11px] text-orange-300">amara</p>
                  shipping the fix tonight
                </div>
                <div class="ml-auto w-fit bg-zinc-950/85 px-3 py-2">
                  <p class="text-[11px] text-orange-300">kofi</p>
                  nice, I will test it first thing
                  <span class="mt-2 flex w-fit gap-1 border border-white/10 px-1.5 text-[11px]">🎉 2</span>
                </div>
                <p class="flex items-center gap-2 text-[11px] text-zinc-300">
                  <span class="typing-dots flex gap-0.5"><i /><i /><i /></span> ben is typing
                </p>
              </div>

              <!-- Push -->
              <div v-else-if="plugin.key === 'push'" class="w-full max-w-sm space-y-2">
                <p class="text-center text-4xl font-light tracking-tight text-white/90">9:41</p>
                <div class="flex gap-3 bg-zinc-950/80 p-3 backdrop-blur">
                  <span class="flex size-9 shrink-0 items-center justify-center bg-orange-500/20"><UIcon name="i-ph-chats-circle-duotone" class="size-5 text-orange-300" /></span>
                  <div class="min-w-0 flex-1">
                    <p class="flex justify-between text-[12px] font-medium">New message <span class="font-normal text-zinc-400">now</span></p>
                    <p class="truncate text-zinc-300">amara: shipping the fix tonight</p>
                  </div>
                </div>
                <div class="flex gap-3 bg-zinc-950/60 p-3 opacity-70">
                  <span class="flex size-9 shrink-0 items-center justify-center bg-orange-500/20"><UIcon name="i-ph-at-duotone" class="size-5 text-orange-300" /></span>
                  <p class="text-zinc-300">kofi mentioned you in #launch</p>
                </div>
              </div>

              <!-- Collaboration -->
              <div v-else-if="plugin.key === 'collab'" class="relative w-full max-w-sm bg-zinc-950/85 p-5">
                <p class="text-base font-semibold text-white">Launch plan</p>
                <p class="mt-3 leading-6 text-zinc-300">
                  We ship on Thursday after the
                  <span class="relative bg-sky-500/25">payments fix<span class="absolute -top-5 left-0 bg-sky-500 px-1 text-[10px] text-zinc-950">kofi</span></span>
                  lands. Amara owns the changelog<span class="relative"><span class="caret ml-px inline-block h-4 w-0.5 translate-y-0.5 bg-orange-400" /><span class="absolute left-0 top-full mt-1 bg-orange-400 px-1 text-[10px] leading-4 text-zinc-950">amara</span></span>
                </p>
                <span class="absolute -right-3 top-12 flex items-center gap-1 bg-orange-500 px-2 py-1 text-[11px] font-medium text-zinc-950">
                  <UIcon name="i-ph-chat-teardrop-text-fill" class="size-3.5" /> 2
                </span>
              </div>

              <!-- Live cursors -->
              <div v-else-if="plugin.key === 'cursors'" class="relative h-56 w-full max-w-sm border border-white/10 bg-zinc-950/70">
                <div class="absolute left-6 top-8 h-16 w-28 border border-white/15 bg-white/5" />
                <div class="absolute right-8 bottom-10 h-12 w-24 border border-sky-400/60 bg-sky-500/10" />
                <span class="cursor-a absolute left-20 top-16"><UIcon name="i-ph-cursor-fill" class="size-5 text-orange-400" /><span class="ml-3 bg-orange-400 px-1 text-[10px] text-zinc-950">amara</span></span>
                <span class="cursor-b absolute right-16 bottom-16"><UIcon name="i-ph-cursor-fill" class="size-5 text-sky-400" /><span class="ml-3 bg-sky-400 px-1 text-[10px] text-zinc-950">kofi</span></span>
              </div>

              <!-- Notifications feed -->
              <div v-else-if="plugin.key === 'feed'" class="w-full max-w-sm bg-zinc-950/85">
                <p class="flex items-center justify-between border-b border-white/10 px-4 py-3 font-medium">
                  Inbox <span class="bg-orange-500 px-1.5 text-[11px] text-zinc-950">2 new</span>
                </p>
                <p v-for="item in [['kofi replied to your comment', true], ['amara invited you to #launch', true], ['ben reacted 🎉 to your message', false]]" :key="String(item[0])" class="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0" :class="!item[1] && 'text-zinc-500'">
                  <span class="size-1.5 shrink-0 rounded-full" :class="item[1] ? 'bg-orange-400' : 'bg-transparent'" />
                  {{ item[0] }}
                </p>
              </div>

              <!-- Live state sync -->
              <div v-else class="grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center gap-3 font-mono text-[12px]">
                <pre class="bg-zinc-950/85 p-3 leading-5"><span class="text-zinc-500">// laptop</span>
{ poll: <span class="text-emerald-300">'open'</span>,
  votes: <span class="text-orange-300">12</span> }</pre>
                <UIcon name="i-ph-arrows-left-right" class="size-5 text-orange-200" />
                <pre class="bg-zinc-950/85 p-3 leading-5"><span class="text-zinc-500">// phone</span>
{ poll: <span class="text-emerald-300">'open'</span>,
  votes: <span class="text-orange-300">12</span> }</pre>
              </div>
            </div>
          </LandingGrainPanel>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.typing-dots i {
  display: block;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
  animation: typing 1.2s infinite;
}

.typing-dots i:nth-child(2) { animation-delay: 0.15s; }
.typing-dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: none; }
  30% { opacity: 1; transform: translateY(-2px); }
}

.caret {
  animation: caret 1s steps(1) infinite;
}

@keyframes caret {
  50% { opacity: 0; }
}

.cursor-a {
  animation: drift-a 6s ease-in-out infinite;
}

.cursor-b {
  animation: drift-b 7s ease-in-out infinite;
}

@keyframes drift-a {
  50% { transform: translate(90px, 40px); }
}

@keyframes drift-b {
  50% { transform: translate(-110px, -30px); }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dots i,
  .caret,
  .cursor-a,
  .cursor-b {
    animation: none;
  }
}
</style>
