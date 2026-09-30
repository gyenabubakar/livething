<script setup lang="ts">
// The first-party plugins as a ledger: what each one does, the hosted service
// it replaces, and the Cloudflare parts it runs on.
const plugins = [
  {
    name: 'Channels & presence',
    icon: 'i-ph-users-three-duotone',
    does: 'Rooms with join rules and a live list of who is here.',
    instead: 'Pub/sub services priced per connection-minute',
    runsOn: ['room object', 'hibernation'],
  },
  {
    name: 'Chat',
    icon: 'i-ph-chats-circle-duotone',
    does: 'Threads, reactions, typing indicators, read state and history.',
    instead: 'Chat APIs priced per monthly user',
    runsOn: ['room object', 'SQLite'],
  },
  {
    name: 'Notifications feed',
    icon: 'i-ph-tray-arrow-down-duotone',
    does: 'An in-app inbox with unread counts, in sync on every device.',
    instead: 'Inbox services priced per notification',
    runsOn: ['user object', 'SQLite'],
  },
  {
    name: 'Push notifications',
    icon: 'i-ph-bell-ringing-duotone',
    does: 'Web, iOS and Android push, sent only when the socket is closed.',
    instead: 'Push services priced per send',
    runsOn: ['user object', 'alarms'],
  },
  {
    name: 'Collaboration',
    icon: 'i-ph-pencil-line-duotone',
    does: 'Shared documents with conflict-free edits and offline merges.',
    instead: 'Sync engines priced per document or per minute',
    runsOn: ['document object', 'binary frames', 'SQLite'],
  },
  {
    name: 'Live cursors',
    icon: 'i-ph-cursor-click-duotone',
    does: 'Cursors, selections and follow mode at full frame rate.',
    instead: 'Multiplayer SDKs priced per active room',
    runsOn: ['room object', 'hibernation'],
  },
  {
    name: 'Live state sync',
    icon: 'i-ph-arrows-clockwise-duotone',
    does: 'A typed store every client shares, checked on the server.',
    instead: 'Realtime databases priced per read and write',
    runsOn: ['room object', 'SQLite'],
  },
  {
    name: 'Durable streams',
    icon: 'i-ph-waveform-duotone',
    does: 'LLM output that keeps going when the phone loses signal.',
    instead: 'A Redis cluster you run just to resume streams',
    runsOn: ['room object', 'SQLite', 'alarms'],
  },
]
</script>

<template>
  <section>
    <div class="frame-row px-6 sm:px-10 py-16">
      <p class="section-label">
        First-party plugins
      </p>
      <h2 class="section-title max-w-3xl">
        Everything you would rent, in your own account<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-xl text-base/7 text-muted">
        Each plugin is a few lines in your server definition. It keeps its data in the SQLite database of the object it runs in, so nothing leaves your Cloudflare account.
      </p>
    </div>

    <div class="frame-row">
      <div class="hidden grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,3fr)] border-b border-default px-10 py-3 text-[10px] font-medium uppercase tracking-widest text-zinc-500 md:grid">
        <span>Plugin</span>
        <span>Instead of</span>
        <span>Runs on</span>
      </div>
      <div
        v-for="plugin in plugins"
        :key="plugin.name"
        class="group grid gap-4 border-b border-default px-6 sm:px-10 py-7 last:border-b-0 transition-colors hover:bg-elevated/40 md:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,3fr)] md:items-center md:gap-8"
      >
        <div class="flex gap-4">
          <span class="flex size-10 shrink-0 items-center justify-center border border-default bg-elevated/50 transition-colors group-hover:border-primary/50">
            <UIcon :name="plugin.icon" class="size-5 text-primary" />
          </span>
          <div>
            <h3 class="font-serif text-xl font-semibold tracking-tight text-highlighted">
              {{ plugin.name }}
            </h3>
            <p class="mt-1 text-sm/6 text-muted">
              {{ plugin.does }}
            </p>
          </div>
        </div>
        <p class="text-sm text-muted">
          {{ plugin.instead }}
        </p>
        <p class="flex flex-wrap gap-1.5">
          <span v-for="part in plugin.runsOn" :key="part" class="border border-orange-400/30 bg-orange-500/[0.07] px-2 py-0.5 font-mono text-[11px] text-orange-700 dark:text-orange-200">{{ part }}</span>
        </p>
      </div>
    </div>
  </section>
</template>
