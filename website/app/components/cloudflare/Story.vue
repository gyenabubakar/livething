<script setup lang="ts">
import { useEventListener } from '@vueuse/core'

// A pinned scene with the story scrolling past it. The last step whose text has
// reached the middle of the screen picks what the scene shows.
const steps = [
  {
    title: 'Everyone connects to a city near them',
    body: 'Amara opens your app in Accra, Kofi in London. Each socket lands in the Cloudflare data centre closest to that person, so the first hop is short wherever your users are.',
  },
  {
    title: 'Every room is a Durable Object',
    body: 'Your Worker picks the room by name. Cloudflare runs exactly one copy of that room in the whole world, and its sockets, its SQLite database and its alarm live inside it. No Redis, no shared database, no two servers racing over the same room.',
    code: 'env.CHAT_ROOM.idFromName(\'room:launch\')',
  },
  {
    title: 'Quiet rooms sleep, and cost nothing',
    body: 'Turn on hibernation and a quiet room leaves memory between messages. The sockets stay open at the edge, Cloudflare answers keepalive pings there, and you are not billed for the idle time.',
    code: 'server({ hibernation: { enabled: true } })',
  },
  {
    title: 'A message wakes it in milliseconds',
    body: 'Kofi sends a message. The room wakes, restores every member, saves the message and sends it to everyone else. A member who dropped off finds it in their inbox when they come back.',
  },
  {
    title: 'Rooms reach people anywhere',
    body: 'Kofi mentions Amara, who has closed the app. The mention goes to Amara\'s own object, lands in the notification feed, and goes out as a push notification to the phone.',
  },
]

const blocks = ref<HTMLElement[]>([])
const active = ref(0)
function track() {
  const line = window.innerHeight * 0.55
  const passed = blocks.value.findLastIndex(block => block.getBoundingClientRect().top <= line)
  active.value = Math.max(0, passed)
}

useEventListener('scroll', track, { passive: true })
onMounted(track)
</script>

<template>
  <section>
    <div class="frame-row px-6 sm:px-10 py-16">
      <p class="section-label">
        How it works
      </p>
      <h2 class="section-title max-w-3xl">
        One room, one Durable Object<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-xl text-base/7 text-muted">
        LiveThing's Cloudflare adapter turns your server into a Durable Object class. Here is what happens to one message, from a phone in Accra to a room and back.
      </p>
    </div>

    <div class="frame-row grid lg:grid-cols-2">
      <div class="max-lg:order-2 lg:border-r border-default lg:pb-[25vh]">
        <article
          v-for="(step, index) in steps"
          :key="step.title"
          class="flex min-h-[55vh] flex-col justify-center px-6 sm:px-10 py-12 transition-opacity duration-500"
          :class="index === active ? 'opacity-100' : 'opacity-30'"
        >
          <div :ref="(el) => { if (el) blocks[index] = el as HTMLElement }">
            <p class="font-mono text-xs text-primary">
              0{{ index + 1 }} / 0{{ steps.length }}
            </p>
            <h3 class="feature-title mt-4">
              {{ step.title }}<span class="text-primary">.</span>
            </h3>
            <p class="mt-4 max-w-md text-base/7 text-muted">
              {{ step.body }}
            </p>
            <code v-if="step.code" class="mt-6 block w-fit border border-default bg-elevated/40 px-3 py-2 font-mono text-xs text-toned">{{ step.code }}</code>
          </div>
        </article>
      </div>

      <div class="max-lg:order-1 max-lg:sticky max-lg:top-16 max-lg:z-10 max-lg:border-b max-lg:border-default max-lg:bg-default">
        <div class="lg:sticky lg:top-16 flex items-center justify-center px-6 py-6 lg:h-[calc(100vh-4rem)] lg:px-12">
          <CloudflareStoryScene :step="active" class="max-h-[42vh] lg:max-h-full" />
        </div>
      </div>
    </div>
  </section>
</template>
