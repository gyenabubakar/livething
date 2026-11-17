<script setup lang="ts">
// Long polling and the two Split Stream modes, run side by side on the same traffic. A clock
// drives the picture: messages and events travel, requests open and end, messages that must
// wait pile up, and the counters keep the totals.
type Lane = 'down' | 'up'
type Flight = { id: number; row: number; lane: Lane; toServer: boolean; label: string; t0: number; dur: number; small?: boolean }
type Row = {
  name: string
  sub: string
  requests: number
  waited: number
  // Long polling only: a GET waits at the server (open), or carries its one answer (answering).
  getOpen: boolean
  answering: boolean
  heldEvents: number
  postBusy: boolean
  queued: number
}

// Seconds. Far slower than real life, so the eye can follow each message.
const TRAVEL = 2.2
const LOOP = 36
const MESSAGES = [1, 2, 3, 22]
const EVENTS = [12, 13.5, 30]
const POLL = 0
const BATCH = 1
const STREAM = 2

const W = 520
const H = 150
const L = 84
const R = 436
const laneY = (lane: Lane) => (lane === 'down' ? 46 : 112)

function freshRows(): Row[] {
  const row = (name: string, sub: string, requests: number): Row => ({
    name, sub, requests, waited: 0, getOpen: true, answering: false, heldEvents: 0, postBusy: false, queued: 0,
  })
  const list: Row[] = []
  list[POLL] = row('Long polling', '', 1)
  list[BATCH] = row('Split Stream', 'batch mode', 1)
  list[STREAM] = row('Split Stream', 'stream mode', 2)
  return list
}

const rows = reactive<Row[]>(freshRows())
const flights = reactive<Flight[]>([])
const now = ref(0)
let clock = 0
let nextId = 0
let timers: { at: number; run: () => void }[] = []

function later(delay: number, run: () => void) {
  const at = clock + delay
  const index = timers.findIndex((timer) => timer.at > at)
  timers.splice(index === -1 ? timers.length : index, 0, { at, run })
}

function fly(row: number, lane: Lane, toServer: boolean, label: string, dur: number, then?: () => void, small = false) {
  const flight = { id: nextId++, row, lane, toServer, label, t0: clock, dur, small }
  flights.push(flight)
  later(dur, () => {
    flights.splice(flights.findIndex((item) => item.id === flight.id), 1)
    then?.()
  })
}

function startPost(index: number, count: number) {
  const row = rows[index]!
  row.postBusy = true
  row.requests++
  fly(index, 'up', true, count === 1 ? 'POST' : `POST ×${count}`, TRAVEL, () => {
    fly(index, 'up', false, '204 done', TRAVEL, () => {
      row.postBusy = false
      if (row.queued > 0) {
        const waiting = row.queued
        row.queued = 0
        startPost(index, waiting)
      }
    }, true)
  })
}

function answerPoll(count: number) {
  const row = rows[POLL]!
  row.getOpen = false
  row.answering = true
  fly(POLL, 'down', false, count === 1 ? 'event' : `event ×${count}`, TRAVEL, () => {
    row.answering = false
    row.requests++
    fly(POLL, 'down', true, 'new GET', TRAVEL, () => {
      row.getOpen = true
      if (row.heldEvents > 0) {
        const waiting = row.heldEvents
        row.heldEvents = 0
        answerPoll(waiting)
      }
    }, true)
  })
}

function sendMessage() {
  rows.forEach((row, index) => {
    if (index === STREAM) fly(index, 'up', true, 'message', TRAVEL)
    else if (row.postBusy) {
      row.queued++
      row.waited++
    }
    else startPost(index, 1)
  })
}

function serverEvent() {
  rows.forEach((row, index) => {
    if (index !== POLL) fly(index, 'down', false, 'event', TRAVEL)
    else if (row.getOpen) answerPoll(1)
    else {
      row.heldEvents++
      row.waited++
    }
  })
}

function scheduleLoop(start: number, repeat: boolean) {
  for (const at of MESSAGES) later(start + at - clock, sendMessage)
  for (const at of EVENTS) later(start + at - clock, serverEvent)
  if (repeat) later(start + LOOP - clock, () => scheduleLoop(start + LOOP, true))
}

function advance(seconds: number) {
  const target = clock + seconds
  while (timers.length > 0 && timers[0]!.at <= target) {
    const timer = timers.shift()!
    clock = timer.at
    timer.run()
  }
  clock = target
  now.value = clock
}

const reduced = ref(false)

/** Runs every timer, and those they add, until nothing is in flight. */
function settle() {
  while (timers.length > 0) advance(timers.at(-1)!.at - clock)
}

function reset() {
  timers = []
  flights.splice(0)
  rows.splice(0, rows.length, ...freshRows())
  clock = 0
  // Without motion, run one loop to its end, so the counters already tell the story.
  scheduleLoop(0.3, !reduced.value)
  if (reduced.value) settle()
  advance(0)
}

function act(action: () => void) {
  action()
  if (reduced.value) settle()
}

const paused = ref(false)
const visible = ref(false)
const svg = useTemplateRef('svg')
let frameId = 0
let lastTime = 0

function frame(time: number) {
  advance(lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0)
  lastTime = time
  frameId = requestAnimationFrame(frame)
}

watch([visible, paused, reduced], ([isVisible, isPaused, isReduced]) => {
  cancelAnimationFrame(frameId)
  lastTime = 0
  if (isVisible && !isPaused && !isReduced) frameId = requestAnimationFrame(frame)
})

let observer: IntersectionObserver | undefined
let motion: MediaQueryList | undefined
// Reduced motion, turned on or off while the page is open, starts the picture again.
function onMotion(): void {
  reduced.value = motion!.matches
  reset()
}

onMounted(() => {
  motion = matchMedia('(prefers-reduced-motion: reduce)')
  onMotion()
  motion.addEventListener('change', onMotion)
  observer = new IntersectionObserver(([entry]) => {
    visible.value = entry!.isIntersecting
  })
  if (svg.value) observer.observe(svg.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  motion?.removeEventListener('change', onMotion)
  cancelAnimationFrame(frameId)
})

const chipWidth = (flight: Flight) => flight.label.length * 7.6 + 22

// A chip is drawn behind its point when it goes to the server, ahead of it when it comes back,
// so it travels from one end of the lane to the other without covering either box.
function flightX(flight: Flight) {
  const progress = Math.min(Math.max((now.value - flight.t0) / flight.dur, 0), 1)
  const distance = (R - L - chipWidth(flight)) * progress
  return flight.toServer ? L + chipWidth(flight) + distance : R - chipWidth(flight) - distance
}

function band(index: number, lane: Lane) {
  const row = rows[index]!
  if (lane === 'down') {
    if (index !== POLL) return 'GET · server-sent events · stays open'
    if (row.getOpen) return 'GET · held until an event'
    return row.answering ? 'GET · answered, so it ends' : ''
  }
  if (index === STREAM) return 'POST · its body stays open'
  return row.postBusy ? 'POST · open until its answer' : ''
}

// All three keep running behind the tabs, so each tab shows its own total on the same traffic.
const current = ref(0)
const notes = [
  'Every event ends the GET, so the browser must open a new one. Messages go up in POSTs, one at a time, so the rest wait.',
  'One GET stays open and carries every event down. Messages go up in POSTs, one at a time, so the rest wait.',
  'One request stays open each way. Every message and event goes at once.',
]
const label = computed(() => {
  const row = rows[current.value]!
  return `${tabName(row)}: ${row.requests} HTTP requests so far, ${row.waited} messages and events had to wait. ${notes[current.value]}`
})

const tabName = (row: Row) => (row.sub ? `${row.name}: ${row.sub}` : row.name)
</script>

<template>
  <SplitStreamFigure v-model:paused="paused" animated caption="All three run the same traffic at the same time, slowed down. Each band is one open HTTP request. Grey chips are the server's answer to a POST (204: done, nothing to send back), or the new GET that long polling opens after each event. The counts leave out pings, the probe, and the first POST that stream mode sends before it opens the long POST.">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <UButton
        v-for="(row, index) in rows"
        :key="index"
        :color="current === index ? 'primary' : 'neutral'"
        :variant="current === index ? 'solid' : 'outline'"
        :aria-pressed="current === index"
        @click="current = index"
      >
        {{ tabName(row) }}
        <span class="tabular-nums opacity-75">{{ row.requests }}</span>
      </UButton>
    </div>

    <p class="mb-1 text-base text-highlighted">
      <strong class="tabular-nums">{{ rows[current]!.requests }}</strong> HTTP requests so far ·
      <span :class="rows[current]!.waited ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
        {{ rows[current]!.waited ? `${rows[current]!.waited} had to wait` : 'nothing waits' }}
      </span>
    </p>
    <p class="mb-3 text-sm text-muted">{{ notes[current] }}</p>

    <svg ref="svg" :viewBox="`0 0 ${W} ${H}`" class="ss-narrow w-full" role="img" :aria-label="label">
      <!-- the two ends -->
      <rect x="1" y="14" width="74" height="130" rx="10" class="fill-(--ui-bg) stroke-(--art-line)" />
      <text x="38" y="84" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Browser</text>
      <rect :x="W - 75" y="14" width="74" height="130" rx="10" class="fill-(--ui-bg) stroke-orange-400/70" />
      <text :x="W - 38" y="84" text-anchor="middle" class="text-[13px] font-medium fill-(--ui-text-highlighted)">Server</text>

      <!-- one band per open request, a dashed line where none is open -->
      <g v-for="lane in (['down', 'up'] as const)" :key="lane">
        <template v-if="band(current, lane)">
          <rect :x="L" :y="laneY(lane) - 15" :width="R - L" height="30" rx="15" :class="lane === 'down' ? 'fill-orange-500/[0.08] stroke-orange-400/50' : 'fill-sky-500/[0.08] stroke-sky-500/50'" />
          <text :x="(L + R) / 2" :y="laneY(lane) + 4.5" text-anchor="middle" class="text-[12px] fill-(--ui-text-muted)">{{ band(current, lane) }}</text>
        </template>
        <template v-else>
          <line :x1="L" :y1="laneY(lane)" :x2="R" :y2="laneY(lane)" class="stroke-(--ui-text-muted)/40" stroke-dasharray="4 5" />
          <text :x="(L + R) / 2" :y="laneY(lane) - 7" text-anchor="middle" class="text-[12px] italic fill-(--ui-text-muted)">no request open</text>
        </template>
      </g>

      <!-- what waits: messages in the browser, events at the server -->
      <circle v-for="dot in Math.min(rows[current]!.queued, 6)" :key="`q${dot}`" :cx="L + 6 + (dot - 1) * 13" :cy="laneY('up') + 27" r="5" class="fill-sky-500" />
      <text v-if="rows[current]!.queued" :x="L + 4 + Math.min(rows[current]!.queued, 6) * 13" :y="laneY('up') + 31.5" class="text-[12px] font-medium fill-sky-700 dark:fill-sky-300">{{ rows[current]!.queued }} waiting</text>
      <circle v-for="dot in Math.min(rows[current]!.heldEvents, 6)" :key="`h${dot}`" :cx="R - 6 - (dot - 1) * 13" :cy="laneY('down') - 27" r="5" class="fill-orange-500" />
      <text v-if="rows[current]!.heldEvents" :x="R - 4 - Math.min(rows[current]!.heldEvents, 6) * 13" :y="laneY('down') - 22.5" text-anchor="end" class="text-[12px] font-medium fill-orange-700 dark:fill-orange-300">{{ rows[current]!.heldEvents }} waiting</text>

      <!-- everything on the way -->
      <g v-for="flight in flights" v-show="flight.row === current" :key="flight.id" :transform="`translate(${flightX(flight)} ${laneY(flight.lane)})`">
        <rect
          :x="flight.toServer ? -chipWidth(flight) : 0" y="-12" :width="chipWidth(flight)" height="24" rx="12"
          :class="flight.small ? 'fill-(--ui-bg) stroke-(--ui-text-muted)/60' : flight.lane === 'down' ? 'fill-orange-500' : 'fill-sky-500'"
        />
        <text
          :x="(flight.toServer ? -1 : 1) * chipWidth(flight) / 2" y="4.5" text-anchor="middle"
          :class="flight.small ? 'text-[12.5px] fill-(--ui-text-muted)' : 'text-[12.5px] font-medium fill-white'"
        >{{ flight.label }}</text>
      </g>
    </svg>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <UButton size="sm" color="neutral" variant="outline" icon="i-ph-paper-plane-tilt" label="Send 3 messages" @click="act(() => { sendMessage(); later(0.4, sendMessage); later(0.8, sendMessage) })" />
      <UButton size="sm" color="neutral" variant="outline" icon="i-ph-broadcast" label="Server sends an event" @click="act(serverEvent)" />
      <UButton size="sm" color="neutral" variant="ghost" icon="i-ph-arrow-counter-clockwise" label="Reset" @click="reset" />
    </div>
  </SplitStreamFigure>
</template>
