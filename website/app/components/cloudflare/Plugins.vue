<script setup lang="ts">
import { useEventListener } from '@vueuse/core'

// The first-party plugins as a showcase: the current plugin is expanded on the
// left and its live preview plays on the right. The same plugins as the landing
// page: one that ships links to its docs, and the others are tagged "coming soon".
const plugins = [
  {
    key: 'chat',
    name: 'Chat',
    icon: 'i-ph-chats-circle-duotone',
    does: 'Threads, reactions, typing indicators, read state and history.',
    instead: 'Chat APIs priced per monthly user',
    runsOn: ['room object', 'SQLite'],
  },
  {
    key: 'push',
    name: 'Push Notifications',
    icon: 'i-ph-bell-ringing-duotone',
    does: 'Web, iOS and Android push, sent only when the socket is closed.',
    instead: 'Push services priced per send',
    runsOn: ['user object', 'alarms'],
  },
  {
    key: 'collab',
    name: 'Collaboration',
    icon: 'i-ph-users-four-duotone',
    does: 'Shared documents and state with conflict-free edits, undo, versions and offline merges.',
    instead: 'Sync engines priced per document or per minute',
    runsOn: ['document object', 'binary frames', 'SQLite'],
    docs: '/plugins/collaboration/overview',
  },
  {
    key: 'feed',
    name: 'Notifications Feed',
    icon: 'i-ph-tray-arrow-down-duotone',
    does: 'An in-app inbox with unread counts, in sync on every device.',
    instead: 'Inbox services priced per notification',
    runsOn: ['user object', 'SQLite'],
  },
  {
    key: 'comments',
    name: 'Comments',
    icon: 'i-ph-chat-teardrop-text-duotone',
    does: 'Comment threads with replies, mentions and reactions, on anything people make.',
    instead: 'Comment services priced per monthly user',
    runsOn: ['room object', 'SQLite'],
  },
] as const

// On large screens the section is scroll-driven: the track is one screen of
// scrolling per plugin, the list and preview stay pinned inside it, and the
// scroll position picks the plugin. Small screens pick by tapping instead.
const STEP_VH = 60
const HEADER = 64

const active = ref(0)
const stepProgress = ref(0)
const track = ref<HTMLElement>()
const preview = ref<HTMLElement>()

const isLarge = () => window.matchMedia('(min-width: 1024px)').matches

function onScroll() {
  if (!track.value || !isLarge()) return
  const stepPx = window.innerHeight * STEP_VH / 100
  const scrolled = Math.max(0, HEADER - track.value.getBoundingClientRect().top)
  const position = Math.min(plugins.length - 0.001, scrolled / stepPx)
  active.value = Math.floor(position)
  stepProgress.value = position - active.value
}

useEventListener('scroll', onScroll, { passive: true })
onMounted(onScroll)

function pick(index: number) {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (isLarge() && track.value) {
    // Land a little into the plugin's stretch, so it is clearly the active one.
    const stepPx = window.innerHeight * STEP_VH / 100
    const top = track.value.getBoundingClientRect().top + window.scrollY - HEADER + (index + 0.1) * stepPx
    window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    return
  }
  active.value = index
  // On small screens the preview sits above the list, often off screen.
  preview.value?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
}
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

    <div ref="track" class="frame-row plugins-track">
      <div class="grid lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:grid-cols-2">
        <ul class="max-lg:order-2 lg:flex lg:flex-col lg:justify-center lg:border-r border-default">
          <li v-for="(plugin, index) in plugins" :key="plugin.key" class="border-b border-default last:border-b-0">
            <button
              type="button"
              class="group w-full px-6 sm:px-10 py-4 text-left transition-colors"
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
                <span v-if="!('docs' in plugin)" class="border border-default px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">Coming soon</span>
                <span v-if="index === active" class="ml-auto h-0.5 w-10 overflow-hidden bg-default max-lg:hidden" aria-hidden="true">
                  <span class="block h-full origin-left bg-primary" :style="{ transform: `scaleX(${stepProgress})` }" />
                </span>
              </span>
              <span class="grid transition-[grid-template-rows] duration-300" :class="index === active ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'">
                <span class="overflow-hidden">
                  <span class="block pt-3 pl-13 text-sm/6 text-muted">{{ plugin.does }}</span>
                  <span class="mt-3 block pl-13 text-xs text-dimmed">Instead of: {{ plugin.instead }}</span>                  <span class="mt-3 flex flex-wrap gap-1.5 pl-13">
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
    </div>
  </section>
</template>

<style scoped>
/* One stretch of scrolling per plugin, plus the pinned screen itself. */
@media (min-width: 1024px) {
  .plugins-track {
    height: calc(v-bind('plugins.length') * 60vh + 100vh - 4rem);
  }
}
</style>
