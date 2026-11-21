<script setup lang="ts">
import { createTimeline, steps } from 'animejs'

// One room's storage, pinned to the EU. A purgeUser call wipes one person's
// rows from every LiveThing table in the room and closes their sockets.
const points = [
  {
    icon: 'i-ph-vault-duotone',
    title: 'Your account, your data',
    body: 'Messages, presence, feeds and documents sit in SQLite inside your own Durable Objects, and nowhere else.',
  },
  {
    icon: 'i-ph-globe-hemisphere-west-duotone',
    title: 'Kept in the right region',
    body: 'Create rooms inside the EU jurisdiction, and Cloudflare stores and runs them only in the EU.',
  },
  {
    icon: 'i-ph-user-minus-duotone',
    title: 'Delete a person in one call',
    body: 'purgeUser removes a user\'s memberships, inbox, read receipts, last-seen time and streams, then closes their sockets.',
  },
]

const tables = [
  { name: 'channel_memberships', rows: [['ama', '#launch'], ['ben', '#launch'], ['kofi', '#launch']] },
  { name: 'inbox', rows: [['ben', 'seq 1042'], ['ama', 'seq 1043']] },
  { name: 'inbox_receipts', rows: [['kofi', 'read 1041'], ['ben', 'read 1040']] },
  { name: 'last_seen', rows: [['ama', '2m ago'], ['ben', '3h ago']] },
]
const benRows = tables.reduce((sum, table) => sum + table.rows.filter(row => row[0] === 'ben').length, 0)
const COMMAND = 'await admin.purgeUser(\'ben\')'

const root = ref<HTMLElement>()

useIllustration(root, () => createTimeline({ loop: true, autoplay: false, defaults: { ease: 'outQuad' } })
  .add('.m-command', { maxWidth: ['0ch', `${COMMAND.length}ch`], duration: 1200, ease: steps(COMMAND.length) }, 600)
  .add('.m-ben', { backgroundColor: ['rgba(239, 68, 68, 0)', 'rgba(239, 68, 68, 0.22)'], duration: 300 }, 2100)
  .add('.m-ben', { maxHeight: ['28px', '0px'], opacity: 0, duration: 450 }, 2900)
  .add('.m-done', { opacity: [0, 1], duration: 300 }, 3400)
  .add('.m-scene', { opacity: 0, duration: 400 }, 6200)
  .add('.m-ben', { maxHeight: '28px', opacity: 1, backgroundColor: 'rgba(239, 68, 68, 0)', duration: 1 }, 6600)
  .add('.m-command', { maxWidth: '0ch', duration: 1 }, 6600)
  .add('.m-done', { opacity: 0, duration: 1 }, 6600)
  .add('.m-scene', { opacity: 1, duration: 1 }, 6601))
</script>

<template>
  <section class="frame-row grid lg:grid-cols-2">
    <div class="flex flex-col justify-center px-6 sm:px-10 py-16 lg:order-2 lg:border-l border-default">
      <p class="section-label">
        Ownership
      </p>
      <h2 class="section-title">
        Your users' data stays with you<span class="text-primary">.</span>
      </h2>
      <ul class="mt-10 max-w-lg space-y-6">
        <li v-for="point in points" :key="point.title" class="flex gap-4">
          <UIcon :name="point.icon" class="mt-0.5 size-6 shrink-0 text-primary" />
          <div>
            <h3 class="font-serif text-lg font-semibold tracking-tight text-highlighted">
              {{ point.title }}
            </h3>
            <p class="mt-1 text-sm/6 text-muted">
              {{ point.body }}
            </p>
          </div>
        </li>
      </ul>
    </div>

    <LandingGrainPanel tone="dusk" class="min-h-[560px] cursor-default select-none">
      <div ref="root" class="flex size-full items-center justify-center p-6 sm:p-10">
        <div class="m-scene w-full max-w-md border border-white/10 bg-zinc-950/90 font-mono text-[11px] text-zinc-300 shadow-2xl">
          <div class="flex items-center justify-between border-b border-white/10 px-4 py-3 font-sans">
            <span class="text-[13px] font-medium text-white">room:launch</span>
            <span class="flex items-center gap-1.5 border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-sky-200">
              <UIcon name="i-ph-map-pin-fill" class="size-3" /> EU jurisdiction
            </span>
          </div>

          <div class="grid grid-cols-2 gap-px bg-white/10">
            <div v-for="table in tables" :key="table.name" class="bg-zinc-950 p-3">
              <p class="mb-2 truncate text-[10px] text-zinc-500">
                __livething_{{ table.name }}
              </p>
              <p
                v-for="row in table.rows"
                :key="row.join()"
                class="flex max-h-7 justify-between overflow-hidden px-1.5 leading-7"
                :class="row[0] === 'ben' && 'm-ben'"
              >
                <span :class="row[0] === 'ben' ? 'text-red-200' : 'text-zinc-200'">{{ row[0] }}</span>
                <span class="text-zinc-500">{{ row[1] }}</span>
              </p>
            </div>
          </div>

          <div class="border-t border-white/10 px-4 py-3 leading-6">
            <p class="flex text-zinc-200">
              <span class="text-orange-400">&gt;&nbsp;</span>
              <span class="m-command inline-block overflow-hidden whitespace-nowrap" :style="{ maxWidth: `${COMMAND.length}ch` }">{{ COMMAND }}</span>
            </p>
            <p class="m-done rm-show text-emerald-300 opacity-0">
              ✓ removed {{ benRows }} rows · closed ben's 2 sockets
            </p>
          </div>
        </div>
      </div>
    </LandingGrainPanel>
  </section>
</template>

<style scoped>
/* Without motion, show the finished picture: Ben's rows are already gone. */
@media (prefers-reduced-motion: reduce) {
  .m-ben {
    display: none;
  }
}
</style>
