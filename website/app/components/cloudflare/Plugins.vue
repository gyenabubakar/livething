<script setup lang="ts">
// The first-party plugins as a showcase: pick one on the left and its live
// preview plays on the right. While nobody has picked, it moves on by itself.
const plugins = [
  {
    key: 'presence',
    name: 'Channels & presence',
    icon: 'i-ph-users-three-duotone',
    does: 'Rooms with join rules and a live list of who is here.',
    instead: 'Pub/sub services priced per connection-minute',
    runsOn: ['room object', 'hibernation'],
  },
  {
    key: 'chat',
    name: 'Chat',
    icon: 'i-ph-chats-circle-duotone',
    does: 'Threads, reactions, typing indicators, read state and history.',
    instead: 'Chat APIs priced per monthly user',
    runsOn: ['room object', 'SQLite'],
  },
  {
    key: 'feed',
    name: 'Notifications feed',
    icon: 'i-ph-tray-arrow-down-duotone',
    does: 'An in-app inbox with unread counts, in sync on every device.',
    instead: 'Inbox services priced per notification',
    runsOn: ['user object', 'SQLite'],
  },
  {
    key: 'push',
    name: 'Push notifications',
    icon: 'i-ph-bell-ringing-duotone',
    does: 'Web, iOS and Android push, sent only when the socket is closed.',
    instead: 'Push services priced per send',
    runsOn: ['user object', 'alarms'],
  },
  {
    key: 'collab',
    name: 'Collaboration',
    icon: 'i-ph-pencil-line-duotone',
    does: 'Shared documents with conflict-free edits and offline merges.',
    instead: 'Sync engines priced per document or per minute',
    runsOn: ['document object', 'binary frames', 'SQLite'],
  },
  {
    key: 'cursors',
    name: 'Live cursors',
    icon: 'i-ph-cursor-click-duotone',
    does: 'Cursors, selections and follow mode at full frame rate.',
    instead: 'Multiplayer SDKs priced per active room',
    runsOn: ['room object', 'hibernation'],
  },
  {
    key: 'state',
    name: 'Live state sync',
    icon: 'i-ph-arrows-clockwise-duotone',
    does: 'A typed store every client shares, checked on the server.',
    instead: 'Realtime databases priced per read and write',
    runsOn: ['room object', 'SQLite'],
  },
  {
    key: 'streams',
    name: 'Durable streams',
    icon: 'i-ph-waveform-duotone',
    does: 'LLM output that keeps going when the phone loses signal.',
    instead: 'A Redis cluster you run just to resume streams',
    runsOn: ['room object', 'SQLite', 'alarms'],
  },
] as const

const active = ref(0)
const picked = ref(false)
const section = ref<HTMLElement>()
let timer: ReturnType<typeof setInterval> | undefined

function stop() {
  clearInterval(timer)
  timer = undefined
}

useViewportActivation(section, {
  threshold: 0.3,
  onEnter() {
    if (picked.value || timer) return
    timer = setInterval(() => { active.value = (active.value + 1) % plugins.length }, 7000)
  },
  onExit: stop,
})
onBeforeUnmount(stop)

const preview = ref<HTMLElement>()

function pick(index: number) {
  picked.value = true
  stop()
  active.value = index
  // On small screens the preview sits above the list, often off screen.
  if (window.matchMedia('(max-width: 1023px)').matches) {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    preview.value?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  }
}
</script>

<template>
  <section ref="section">
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

    <div class="frame-row grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <ul class="max-lg:order-2 lg:border-r border-default">
        <li v-for="(plugin, index) in plugins" :key="plugin.key" class="border-b border-default last:border-b-0">
          <button
            type="button"
            class="group w-full px-6 sm:px-10 py-5 text-left transition-colors"
            :class="index === active ? 'bg-elevated/40' : 'hover:bg-elevated/20'"
            :aria-current="index === active || undefined"
            @click="pick(index)"
          >
            <span class="flex items-center gap-4">
              <span
                class="flex size-9 shrink-0 items-center justify-center border transition-colors"
                :class="index === active ? 'border-primary/60 bg-primary/10' : 'border-default bg-elevated/50'"
              >
                <UIcon :name="plugin.icon" class="size-5" :class="index === active ? 'text-primary' : 'text-muted'" />
              </span>
              <span class="font-serif text-lg font-semibold tracking-tight" :class="index === active ? 'text-highlighted' : 'text-toned'">{{ plugin.name }}</span>
              <span v-if="index === active && !picked" class="ml-auto h-0.5 w-10 overflow-hidden bg-default" aria-hidden="true">
                <span :key="active" class="progress block h-full bg-primary" />
              </span>
            </span>
            <span class="grid transition-[grid-template-rows] duration-300" :class="index === active ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'">
              <span class="overflow-hidden">
                <span class="block pt-3 pl-13 text-sm/6 text-muted">{{ plugin.does }}</span>
                <span class="mt-3 block pl-13 text-xs text-dimmed">Instead of: {{ plugin.instead }}</span>
                <span class="mt-3 flex flex-wrap gap-1.5 pl-13">
                  <span v-for="part in plugin.runsOn" :key="part" class="border border-orange-400/30 bg-orange-500/[0.07] px-2 py-0.5 font-mono text-[11px] text-orange-700 dark:text-orange-200">{{ part }}</span>
                </span>
              </span>
            </span>
          </button>
        </li>
      </ul>

      <div ref="preview" class="scroll-mt-16 max-lg:order-1 max-lg:border-b max-lg:border-default">
        <LandingGrainPanel :tone="active % 2 ? 'dusk' : 'ember'" class="h-full min-h-[30rem] cursor-default select-none">
          <div class="flex size-full items-center justify-center p-8 lg:scale-[1.2]">
            <Transition mode="out-in" enter-from-class="opacity-0 translate-y-2" leave-to-class="opacity-0" enter-active-class="transition duration-300" leave-active-class="transition duration-200">
              <PluginMock :key="plugins[active]!.key" :kind="plugins[active]!.key" />
            </Transition>
          </div>
        </LandingGrainPanel>
      </div>
    </div>
  </section>
</template>

<style scoped>
.progress {
  animation: progress 7s linear;
  transform-origin: left;
}

@keyframes progress {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
</style>
