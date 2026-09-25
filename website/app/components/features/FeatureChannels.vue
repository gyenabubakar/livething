<script setup lang="ts">
import { Motion } from 'motion-v'
import type { TimedEvent } from '~/composables/useTimedSequence'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Rooms', icon: 'i-ph-door-open-duotone' },
  { label: 'Auth gate', icon: 'i-ph-lock-key-duotone' },
  { label: 'Presence', icon: 'i-ph-users-three-duotone' },
]

/* ----------------------------------------------------------------------------
 * One scene, four beats, played one after another:
 *   1. ada asks to join #general, the server's check() lets her in
 *   2. jo asks with a bad token, check() refuses and the request bounces back
 *   3. lin sends a message, the server delivers it to room members only
 *   4. max goes offline but stays a member, then comes back online
 * Clients sit on the left, the server and its room on the right.
 * ------------------------------------------------------------------------- */

type Name = 'ada' | 'lin' | 'max' | 'jo'
type Tone = 'pink' | 'emerald' | 'red'

interface Client {
  name: Name
  member: boolean
  online: boolean
  note: string
}

interface Packet {
  visible: boolean
  atServer: boolean
  tone: Tone
  label: string
}

const names: Name[] = ['ada', 'lin', 'max', 'jo']

function freshClients(): Client[] {
  return [
    { name: 'ada', member: false, online: true, note: '' },
    { name: 'lin', member: true, online: true, note: '' },
    { name: 'max', member: true, online: true, note: '' },
    { name: 'jo', member: false, online: true, note: '' },
  ]
}

function freshPackets(): Record<Name, Packet> {
  return {
    ada: { visible: false, atServer: false, tone: 'pink', label: '' },
    lin: { visible: false, atServer: false, tone: 'pink', label: '' },
    max: { visible: false, atServer: false, tone: 'pink', label: '' },
    jo: { visible: false, atServer: false, tone: 'pink', label: '' },
  }
}

const clients = ref<Client[]>(freshClients())
const packets = ref<Record<Name, Packet>>(freshPackets())
const gate = ref<'idle' | 'checking' | 'pass' | 'deny'>('idle')
const caption = ref('')

const members = computed(() => clients.value.filter(client => client.member))
const onlineCount = computed(() => members.value.filter(member => member.online).length)

function client(name: Name): Client {
  return clients.value.find(entry => entry.name === name)!
}

// A packet appears at one end of a client's wire; `travel` moves it to the other end.
function launch(name: Name, from: 'client' | 'server', tone: Tone, label: string) {
  packets.value[name] = { visible: true, atServer: from === 'server', tone, label }
}

function travel(name: Name) {
  packets.value[name].atServer = !packets.value[name].atServer
}

function land(name: Name) {
  packets.value[name].visible = false
}

function resetScene() {
  clients.value = freshClients()
  packets.value = freshPackets()
  gate.value = 'idle'
  caption.value = ''
}

const events: TimedEvent[] = [
  // 1. gated join: ada is let in
  { at: 400, run: () => { caption.value = 'ada asks to join #general' } },
  { at: 500, run: () => launch('ada', 'client', 'pink', 'subscribe') },
  { at: 560, run: () => travel('ada') },
  { at: 1500, run: () => { land('ada'); gate.value = 'checking' } },
  { at: 2200, run: () => { gate.value = 'pass'; caption.value = 'your check() runs on the server and lets ada in' } },
  { at: 2500, run: () => { client('ada').member = true; client('ada').note = 'joined' } },
  { at: 2700, run: () => { launch('lin', 'server', 'pink', 'ada joined'); launch('max', 'server', 'pink', 'ada joined') } },
  { at: 2760, run: () => { travel('lin'); travel('max') } },
  { at: 3700, run: () => { land('lin'); land('max'); gate.value = 'idle'; client('ada').note = '' } },

  // 2. gated join: jo is refused
  { at: 4300, run: () => { caption.value = 'jo asks to join with a bad token' } },
  { at: 4400, run: () => launch('jo', 'client', 'pink', 'subscribe') },
  { at: 4460, run: () => travel('jo') },
  { at: 5400, run: () => { gate.value = 'checking' } },
  { at: 6100, run: () => { gate.value = 'deny'; caption.value = 'check() refuses: jo never joins the room' } },
  { at: 6300, run: () => { packets.value.jo.tone = 'red'; packets.value.jo.label = 'denied' } },
  { at: 6360, run: () => travel('jo') },
  { at: 7300, run: () => { land('jo'); client('jo').note = 'denied'; gate.value = 'idle' } },

  // 3. scoped broadcast: only members receive it
  { at: 8000, run: () => { caption.value = 'lin sends a message to #general'; client('jo').note = '' } },
  { at: 8100, run: () => launch('lin', 'client', 'emerald', 'hey all') },
  { at: 8160, run: () => travel('lin') },
  { at: 9100, run: () => { land('lin'); caption.value = 'the server delivers it to room members only' } },
  { at: 9300, run: () => { launch('ada', 'server', 'emerald', 'hey all'); launch('max', 'server', 'emerald', 'hey all') } },
  { at: 9360, run: () => { travel('ada'); travel('max') } },
  { at: 9400, run: () => { client('jo').note = 'not a member' } },
  { at: 10300, run: () => { land('ada'); land('max'); client('ada').note = 'got it'; client('max').note = 'got it' } },

  // 4. presence: offline is not leaving
  { at: 11600, run: () => { client('ada').note = ''; client('max').note = ''; client('jo').note = '' } },
  { at: 11700, run: () => { client('max').online = false; client('max').note = 'offline'; caption.value = 'max goes offline but stays a member' } },
  { at: 13900, run: () => { client('max').online = true; client('max').note = 'back'; caption.value = 'max reconnects: back online, never left the room' } },
  { at: 15600, run: () => { client('max').note = '' } },
]

const prefersReducedMotion = ref(false)
const demoRef = ref<HTMLElement>()
const sequence = useTimedSequence({ events, totalDuration: 16600, loop: true, onReset: resetScene })

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

useViewportActivation(demoRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: () => {
    sequence.start()
    sequence.resume()
  },
  onExit: sequence.pause,
})

const toneDot: Record<Tone, string> = {
  pink: 'bg-pink-400 shadow-pink-400/70',
  emerald: 'bg-emerald-400 shadow-emerald-400/70',
  red: 'bg-red-400 shadow-red-400/70',
}

const toneText: Record<Tone, string> = {
  pink: 'text-pink-300',
  emerald: 'text-emerald-300',
  red: 'text-red-300',
}

function chipClass(entry: Client): string {
  if (!entry.online) return 'border-muted/40 opacity-50'
  if (entry.note === 'denied' || entry.note === 'not a member') return 'border-red-400/40 bg-red-500/[0.06]'
  if (entry.member) return 'border-emerald-400/35 bg-emerald-500/[0.05]'

  return 'border-muted'
}

const gateClass = computed(() => {
  if (gate.value === 'pass') return 'border-emerald-400/60 bg-emerald-500/10 text-emerald-300'
  if (gate.value === 'deny') return 'border-red-400/60 bg-red-500/10 text-red-300'
  if (gate.value === 'checking') return 'border-pink-400/60 bg-pink-500/10 text-pink-300'

  return 'border-muted text-toned'
})
</script>

<template>
  <section class="deferred-section pt-16 md:pt-20 pb-24 md:pb-32">
    <!-- Top: copy + server code -->
    <div class="grid gap-8 lg:grid-cols-2 lg:gap-12 *:min-w-0 items-stretch">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
      >
        <div>
          <p v-if="$slots.headline" class="section-label">
            <slot name="headline" mdc-unwrap="p" />
          </p>
          <div class="relative mb-5">
            <h2 class="section-title max-w-xl">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </h2>
            <div aria-hidden="true" v-play-when-visible class="absolute inset-0 section-title max-w-xl blur-xs animate-pulse pointer-events-none">
              <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
            </div>
          </div>
          <p v-if="$slots.description" class="max-w-lg text-sm leading-relaxed text-toned [&_code]:font-mono [&_code]:text-primary [&_code]:bg-elevated/60 [&_code]:px-1">
            <slot name="description" mdc-unwrap="p" />
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <span
              v-for="pill in pills"
              :key="pill.label"
              class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-toned"
            >
              <UIcon :name="pill.icon" class="size-3.5 text-emerald-400" />
              {{ pill.label }}
            </span>
          </div>
          <NuxtLink v-if="props.link" :to="props.link" class="mt-5 group inline-flex items-center gap-1.5 font-mono text-xs text-primary transition-colors">
            <span class="border-b border-primary/50 pb-0.5 transition-colors group-hover:border-primary">{{ props.linkLabel || 'Learn more' }}</span>
            <UIcon name="i-ph-arrow-right-duotone" class="size-4 transition-transform group-hover:translate-x-0.5" />
          </NuxtLink>
        </div>
      </Motion>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.15 }"
        :in-view-options="{ once: true }"
        class="h-full"
      >
        <div class="h-full flex flex-col overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2.5 border-b border-muted px-4 py-2.5">
            <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
              <span class="size-1.5 rounded-full bg-emerald-400" /> server
            </span>
            <span class="font-mono text-xs text-toned">chat.server.ts</span>
          </div>
          <div class="flex-1 flex flex-col justify-center p-5 font-mono text-xs sm:text-sm leading-loose overflow-x-auto">
            <pre><code><span class="text-violet-400">const</span> room = base.<span class="text-amber-400">channel</span>(<span class="text-emerald-400">'general'</span>, {
  <span class="text-sky-400">subscribe</span>: v.<span class="text-amber-400">object</span>({ token: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">check</span>: (ctx, { token }) => <span class="text-amber-400">assertMember</span>(token),
})

room.<span class="text-amber-400">on</span>(<span class="text-emerald-400">'send'</span>, {
  <span class="text-sky-400">input</span>: v.<span class="text-amber-400">object</span>({ text: v.<span class="text-amber-400">string</span>() }),
  <span class="text-sky-400">run</span>(ctx, { text }) {
<span class="block -mx-5 border-l-2 border-emerald-500/70 bg-emerald-500/10 pl-[calc(1.25rem-2px)] pr-5">    <span class="text-dimmed">// only this room's members hear it</span>
    ctx.channel.<span class="text-amber-400">broadcast</span>(<span class="text-emerald-400">'message'</span>, { <span class="text-sky-400">from</span>: ctx.meta.username, text })</span>  },
})</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width scene: gated join, refused join, scoped broadcast, presence -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="demoRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-broadcast-duotone" class="size-4 text-pink-400" />
          <span class="font-mono text-xs sm:text-sm text-toned">#general</span>
          <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
            <span class="size-1.5 rounded-full bg-emerald-400" /> {{ onlineCount }} online
          </span>
        </div>

        <div class="grid grid-cols-[4.5rem_minmax(0,1fr)_9.5rem] sm:grid-cols-[7rem_minmax(0,1fr)_13rem] items-stretch gap-x-2 sm:gap-x-4 px-3 sm:px-8 py-7">
          <!-- Left: the clients, one per row, each on its own wire to the server -->
          <div class="col-start-1 row-start-1 flex flex-col justify-between gap-3">
            <div
              v-for="entry in clients"
              :key="entry.name"
              class="flex h-12 flex-col justify-center border px-2 sm:px-3 font-mono transition-all duration-500"
              :class="chipClass(entry)"
            >
              <span class="flex items-center gap-1.5 text-xs sm:text-[13px] text-toned">
                <UIcon name="i-ph-device-mobile-duotone" class="size-3.5 shrink-0 text-dimmed" />
                {{ entry.name }}
              </span>
              <span class="h-3.5 text-[10px] leading-3.5 text-muted">{{ entry.note }}</span>
            </div>
          </div>

          <!-- Middle: the wires. A packet travels along a client's wire, toward the server or back. -->
          <div class="col-start-2 row-start-1 flex flex-col justify-between gap-3">
            <div v-for="name in names" :key="name" class="relative flex h-12 items-center">
              <div
                class="h-px w-full transition-colors duration-500"
                :class="client(name).online ? 'bg-muted/60' : 'bg-transparent border-t border-dashed border-muted/40'"
              />
              <div
                class="absolute top-1/2 flex -translate-y-1/2 flex-col items-center transition-[left,opacity] duration-[900ms] ease-in-out"
                :class="packets[name].visible ? 'opacity-100' : 'opacity-0'"
                :style="{ left: packets[name].atServer ? 'calc(100% - 0.5rem)' : '0rem' }"
              >
                <span
                  class="absolute bottom-3 whitespace-nowrap font-mono text-[10px]"
                  :class="[toneText[packets[name].tone], packets[name].atServer ? 'right-0' : 'left-0']"
                >{{ packets[name].label }}</span>
                <span class="size-2 rounded-full shadow-[0_0_10px]" :class="toneDot[packets[name].tone]" />
              </div>
            </div>
          </div>

          <!-- Right: the server, with your check() at the door and the room behind it -->
          <div class="col-start-3 row-start-1 flex flex-col border border-muted bg-elevated/20 p-2 sm:p-3 font-mono">
            <span class="flex items-center gap-1.5 text-[11px] text-toned">
              <UIcon name="i-ph-hard-drives-duotone" class="size-3.5 text-pink-300" /> server
            </span>
            <div
              class="mt-2 flex items-center gap-1.5 border px-2 py-1.5 text-[11px] transition-colors duration-300"
              :class="gateClass"
            >
              <UIcon :name="gate === 'deny' ? 'i-ph-lock-key-duotone' : 'i-ph-lock-key-open-duotone'" class="size-3.5 shrink-0" />
              check(token)
            </div>
            <div class="mt-2 flex-1 border border-emerald-400/25 px-2 py-1.5">
              <span class="text-[11px] text-emerald-300">#general</span>
              <ul class="mt-1 space-y-1">
                <li
                  v-for="member in members"
                  :key="member.name"
                  class="flex items-center gap-1.5 text-[11px] text-toned"
                >
                  <span
                    class="size-1.5 rounded-full transition-colors duration-500"
                    :class="member.online ? 'bg-emerald-400' : 'bg-transparent border border-muted'"
                  />
                  {{ member.name }}
                  <span v-if="!member.online" class="text-[10px] text-muted">offline</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="flex h-14 sm:h-11 items-center gap-2 border-t border-muted/60 px-4 font-mono text-xs text-toned" aria-live="polite">
          <UIcon name="i-ph-shield-check-duotone" class="size-4 shrink-0 text-emerald-400" />
          <span class="line-clamp-2">{{ caption }}</span>
        </div>
      </div>
    </Motion>
  </section>
</template>
