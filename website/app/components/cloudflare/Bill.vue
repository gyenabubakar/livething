<script setup lang="ts">
// A monthly bill for a chat app, worked out from Cloudflare's published
// Durable Objects rates (Workers Paid, September 2026). The two hosted
// figures use public list prices of the two common pricing models.
const MONTH_SECONDS = 2_592_000
const MONTH_MINUTES = 43_200

const CF = {
  plan: 5,
  requestsIncluded: 1_000_000,
  requestPrice: 0.15 / 1_000_000,
  // Cloudflare bills 20 incoming WebSocket messages as one request.
  wsRatio: 20,
  durationIncluded: 400_000,
  durationPrice: 12.5 / 1_000_000,
  objectGb: 0.128,
  rowsIncluded: 50_000_000,
  rowPrice: 1 / 1_000_000,
  storageIncludedGb: 5,
  storagePrice: 0.2,
}
const SESSIONS_PER_PERSON = 60
const KB_PER_MESSAGE = 1

// Log sliders: the thumb moves in steps of 0..1000 and maps onto a wide range,
// rounded to two significant digits so the numbers read like estimates.
function logRange(min: number, max: number) {
  return {
    toValue: (step: number) => Number((min * (max / min) ** (step / 1000)).toPrecision(2)),
    toStep: (value: number) => Math.round(Math.log(value / min) / Math.log(max / min) * 1000),
  }
}
const peopleRange = logRange(100, 200_000)
const messagesRange = logRange(1_000_000, 2_000_000_000)

const peopleStep = ref(peopleRange.toStep(5_000))
const messagesStep = ref(messagesRange.toStep(50_000_000))
const roomSize = ref(50)
const awake = ref(20)

const people = computed(() => peopleRange.toValue(peopleStep.value))
const messages = computed(() => messagesRange.toValue(messagesStep.value))

const sliders = computed(() => [
  { label: 'People online at peak', shown: people.value.toLocaleString('en'), model: peopleStep, min: 0, max: 1000 },
  { label: 'Messages sent per month', shown: compact(messages.value), model: messagesStep, min: 0, max: 1000 },
  { label: 'People per room', shown: roomSize.value, model: roomSize, min: 2, max: 500 },
  { label: 'Time a room is awake', shown: `${awake.value}%`, model: awake, min: 1, max: 100 },
])

// USlider names every thumb "Thumb", so give each one its real label.
const sliderList = ref<HTMLElement>()
onMounted(() => {
  sliderList.value?.querySelectorAll('[role="slider"]').forEach((thumb, index) => {
    thumb.setAttribute('aria-label', sliders.value[index]!.label)
  })
})

const lines = computed(() => {
  const rooms = Math.ceil(people.value / roomSize.value)
  const requests = messages.value / CF.wsRatio + people.value * SESSIONS_PER_PERSON
  const gbSeconds = rooms * CF.objectGb * MONTH_SECONDS * (awake.value / 100)
  const storedGb = messages.value * KB_PER_MESSAGE / 1_000_000
  return [
    { label: 'Workers Paid plan', detail: 'includes the allowances below', cost: CF.plan },
    { label: 'Requests', detail: `${compact(requests)} (messages count 1 in 20)`, cost: Math.max(0, requests - CF.requestsIncluded) * CF.requestPrice },
    { label: 'Duration', detail: `${compact(rooms)} rooms awake ${awake.value}% of the time`, cost: Math.max(0, gbSeconds - CF.durationIncluded) * CF.durationPrice },
    { label: 'SQLite writes', detail: `${compact(messages.value)} rows, one per message`, cost: Math.max(0, messages.value - CF.rowsIncluded) * CF.rowPrice },
    { label: 'SQLite storage', detail: `${compact(storedGb)} GB of message history`, cost: Math.max(0, storedGb - CF.storageIncludedGb) * CF.storagePrice },
  ]
})
const total = computed(() => lines.value.reduce((sum, line) => sum + line.cost, 0))

// Per message plus per connection-minute: each message counted once in and once out.
const perMessage = computed(() => 29 + messages.value * 2 * 2.5 / 1_000_000 + people.value * MONTH_MINUTES / 1_000_000)
// Per monthly active user: about ten monthly users for every person online at peak.
const perUser = computed(() => 399 + Math.max(0, people.value * 10 - 10_000) * 0.09)

const bars = computed(() => {
  const list = [
    { label: 'Priced per message and connection-minute', cost: perMessage.value },
    { label: 'Priced per monthly active user', cost: perUser.value },
    { label: 'LiveThing on your Cloudflare account', cost: total.value, ours: true },
  ]
  const max = Math.max(...list.map(bar => bar.cost))
  return list.map(bar => ({ ...bar, width: Math.max(0.6, bar.cost / max * 100) }))
})

function compact(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1000 ? 2 : 0 }).format(value)
}

const receipt = ref<HTMLElement>()
const printed = ref(false)
useViewportActivation(receipt, { threshold: 0.3, onEnter: () => { printed.value = true } })
</script>

<template>
  <section id="the-bill" class="scroll-mt-16">
    <div class="frame-row px-6 sm:px-10 py-16">
      <p class="section-label">
        The bill
      </p>
      <h2 class="section-title max-w-3xl">
        Pay for compute, not for success<span class="text-primary">.</span>
      </h2>
      <p class="mt-5 max-w-xl text-base/7 text-muted">
        Hosted realtime is priced per connection, per message or per monthly user, so growth raises the bill. On Cloudflare you pay for requests, awake time and storage, and quiet rooms cost nothing. Move the sliders to see a month of a chat app.
      </p>
    </div>

    <div class="frame-row grid lg:grid-cols-2">
      <div class="flex flex-col gap-8 px-6 sm:px-10 py-12 lg:border-r border-default">
        <div ref="sliderList" class="flex flex-col gap-8">
          <div v-for="slider in sliders" :key="slider.label">
            <p class="flex items-baseline justify-between text-sm text-toned">
              {{ slider.label }} <span class="font-mono text-highlighted">{{ slider.shown }}</span>
            </p>
            <USlider v-model="slider.model.value" :min="slider.min" :max="slider.max" size="sm" class="mt-4" />
          </div>
        </div>

        <div class="mt-4 space-y-5 border-t border-default pt-8">
          <p class="text-xs font-medium uppercase tracking-widest text-zinc-500">
            The same month, three ways
          </p>
          <div v-for="bar in bars" :key="bar.label">
            <p class="flex items-baseline justify-between gap-4 text-sm" :class="bar.ours ? 'text-highlighted' : 'text-muted'">
              {{ bar.label }}
              <span class="font-mono" :class="bar.ours && 'text-primary'">{{ money(bar.cost) }}</span>
            </p>
            <div class="mt-2 h-2 bg-elevated">
              <div class="h-full transition-[width] duration-500" :class="bar.ours ? 'bg-primary' : 'bg-zinc-400 dark:bg-zinc-600'" :style="{ width: `${bar.width}%` }" />
            </div>
          </div>
          <p class="text-xs/5 text-dimmed">
            Cloudflare rates and hosted list prices as of September 2026. The hosted figures count each message once in and once out and assume ten monthly users per person online, which is lower than most real bills.
          </p>
        </div>
      </div>

      <LandingGrainPanel tone="dusk" class="min-h-[560px]">
        <div ref="receipt" class="flex size-full flex-col items-center justify-center px-6 py-12">
          <!-- the printer's slot; the receipt slides out from under it -->
          <div class="relative z-10 h-3 w-full max-w-sm bg-zinc-950 shadow-[0_6px_12px_rgb(0_0_0/0.45)]" />
          <div class="-mt-1.5 w-full max-w-[22rem] overflow-hidden">
            <div class="receipt px-6 pt-8 pb-10 font-mono text-[12px] text-zinc-800" :class="printed ? 'receipt-printed' : ''">
              <div class="flex items-center justify-between border-b border-dashed border-zinc-400 pb-4">
                <span class="flex items-center gap-2 font-sans text-sm font-semibold text-zinc-950"><AppLogoMark class="h-5 w-auto" /> chat app</span>
                <span class="text-[10px] uppercase tracking-widest text-zinc-500">monthly</span>
              </div>
              <ul class="space-y-3 border-b border-dashed border-zinc-400 py-4">
                <li v-for="line in lines" :key="line.label">
                  <p class="flex items-baseline gap-2">
                    <span>{{ line.label }}</span>
                    <span class="flex-1 translate-y-[-3px] border-b border-dotted border-zinc-400" />
                    <span class="text-zinc-950">{{ money(line.cost) }}</span>
                  </p>
                  <p class="text-[10px] text-zinc-500">
                    {{ line.detail }}
                  </p>
                </li>
              </ul>
              <p class="flex items-baseline justify-between pt-4 font-sans">
                <span class="text-sm font-medium">Total</span>
                <span class="font-serif text-3xl font-semibold text-zinc-950">{{ money(total) }}</span>
              </p>
              <p class="mt-6 text-center text-[10px] uppercase tracking-widest text-zinc-500">
                No per-seat fees · no message caps
              </p>
            </div>
          </div>
        </div>
      </LandingGrainPanel>
    </div>
  </section>
</template>

<style scoped>
.receipt {
  background: #f6f3ec;
  /* A torn, zig-zag bottom edge. */
  mask:
    conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom / 14px 7px repeat-x,
    linear-gradient(#000 0 0) top / 100% calc(100% - 7px) no-repeat;
  transform: translateY(-100%);
}

.receipt-printed {
  animation: print 1.8s steps(18) forwards;
}

@keyframes print {
  to { transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .receipt {
    transform: none;
  }

  .receipt-printed {
    animation: none;
  }
}
</style>
