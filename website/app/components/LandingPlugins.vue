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
    name: 'Push Notifications',
    icon: 'i-ph-bell-ringing-duotone',
    title: 'Reach people when their socket is closed',
    features: ['Web push', 'iOS and Android push', 'Sent only when a user is offline', 'Per-user preferences'],
  },
  {
    key: 'collab',
    name: 'Collaboration',
    icon: 'i-ph-users-four-duotone',
    title: 'Shared documents and state that many people edit at once',
    features: ['Conflict-free edits to text and typed data', 'Undo, redo and version history', 'Comments stay on the right spot as people edit', 'Offline edits merge on reconnect'],
  },
  {
    key: 'feed',
    name: 'Notifications Feed',
    icon: 'i-ph-tray-arrow-down-duotone',
    title: 'An in-app inbox that stays in sync on every device',
    features: ['Unread counts', 'Mark as read everywhere', 'Grouping', 'Live, or on the next visit'],
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

          <LandingGrainPanel :tone="index % 2 ? 'dusk' : 'ember'" class="min-h-[26rem] cursor-default select-none">
            <div class="flex size-full items-center justify-center p-8">
              <PluginMock :kind="plugin.key" />
            </div>
          </LandingGrainPanel>
        </article>
      </div>
    </div>
  </section>
</template>
