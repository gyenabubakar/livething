<script setup lang="ts">
import { Motion } from 'motion-v'

const prefersReducedMotion = ref(false)
const delivered = ref(false)
const demoRef = ref<HTMLElement>()

let cycleInterval: ReturnType<typeof setInterval> | undefined
let clearTimer: ReturnType<typeof setTimeout> | undefined

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'Rooms', icon: 'i-ph-door-open-duotone' },
  { label: 'Auth gate', icon: 'i-ph-lock-key-duotone' },
  { label: 'Presence', icon: 'i-ph-users-three-duotone' },
]

// Three members of "general" + one outsider who never hears the broadcast.
const members = [
  { name: 'ada', delay: '0ms' },
  { name: 'lin', delay: '160ms' },
  { name: 'max', delay: '320ms' },
]
const outsider = { name: 'jo', room: 'lobby' }

function pulse() {
  delivered.value = true
  clearTimer = setTimeout(() => {
    delivered.value = false
  }, 3200)
}

function startCycle() {
  if (cycleInterval) return
  pulse()
  cycleInterval = setInterval(pulse, 4800)
}

function stopCycle() {
  if (cycleInterval) {
    clearInterval(cycleInterval)
    cycleInterval = undefined
  }
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = undefined
  }
  delivered.value = false
}

onMounted(() => {
  prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion.value) delivered.value = true
})

useViewportActivation(demoRef, {
  threshold: 0.3,
  disabled: prefersReducedMotion,
  onEnter: startCycle,
  onExit: stopCycle,
})

onBeforeUnmount(stopCycle)
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
    <span class="text-dimmed">// only this room's members hear it</span>
    ctx.channel.<span class="text-amber-400">broadcast</span>(<span class="text-emerald-400">'message'</span>, { <span class="text-sky-400">from</span>: ctx.meta.username, text })
  },
})</code></pre>
          </div>
        </div>
      </Motion>
    </div>

    <!-- Full-width wire: a broadcast fans out to room members; the outsider stays dark -->
    <Motion
      :initial="false"
      :while-in-view="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.5, delay: 0.2 }"
      :in-view-options="{ once: true }"
      class="mt-10 block"
    >
      <div ref="demoRef" class="overflow-hidden border border-muted bg-default">
        <div class="flex items-center gap-2.5 border-b border-muted px-4 py-3">
          <UIcon name="i-ph-broadcast-duotone" class="size-4 text-pink-400" :class="{ 'animate-pulse': delivered }" />
          <span class="font-mono text-xs sm:text-sm text-toned">#general · membership lives on the server</span>
          <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
            <span class="size-1.5 rounded-full bg-emerald-400" /> 3 online
          </span>
        </div>

        <div class="grid lg:grid-cols-[1.35fr_1fr]">
          <!-- Left: a broadcast scoped to the room's members -->
          <div class="px-5 sm:px-8 py-7">
            <p class="mb-6 font-mono text-[11px] tracking-wide text-toned">scoped broadcast → only room members</p>
            <div class="grid grid-cols-[auto_1fr] gap-0">
              <!-- server: the broadcaster -->
              <div class="flex items-center pr-2">
                <div
                  class="border px-4 py-3 transition-colors duration-300"
                  :class="delivered ? 'border-pink-500/50 bg-pink-500/[0.08]' : 'border-muted bg-elevated/20'"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-ph-hard-drives-duotone" class="size-4 text-pink-300 shrink-0" />
                    <span class="font-mono text-xs text-toned">server</span>
                  </div>
                  <div class="mt-2 font-mono text-[11px] text-toned">ctx.channel.broadcast</div>
                  <div class="mt-1 font-mono text-[11px]">
                    <span class="text-emerald-300">'message'</span> <span class="text-muted">"hey all"</span>
                  </div>
                </div>
              </div>

              <!-- the room: members receive, outsider doesn't -->
              <div class="relative flex flex-col justify-center gap-3.5">
                <div class="absolute left-0 top-[10%] bottom-[10%] w-px bg-muted/40" />

                <div
                  v-for="m in members"
                  :key="m.name"
                  class="relative flex items-center gap-0 pl-0"
                >
                  <div class="relative h-px w-8 sm:w-14 bg-muted/40 shrink-0">
                    <span
                      class="absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-emerald-400 shadow-[0_0_10px] shadow-emerald-400/70 transition-all ease-out"
                      :style="{ left: delivered ? '100%' : '0%', transitionDelay: delivered ? m.delay : '0ms', transitionDuration: '650ms' }"
                      :class="delivered ? 'opacity-100' : 'opacity-0'"
                    />
                  </div>
                  <div
                    class="flex items-center gap-2.5 border px-3 py-2 font-mono text-xs sm:text-[13px] transition-all duration-300"
                    :style="{ transitionDelay: delivered ? m.delay : '0ms' }"
                    :class="delivered ? 'border-emerald-400/45 bg-emerald-500/[0.08]' : 'border-muted/50'"
                  >
                    <span class="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span class="w-8 text-toned">{{ m.name }}</span>
                    <UIcon
                      name="i-ph-arrow-left-duotone"
                      class="size-3.5 text-emerald-300 transition-opacity duration-300"
                      :style="{ transitionDelay: delivered ? m.delay : '0ms' }"
                      :class="delivered ? 'opacity-100' : 'opacity-0'"
                    />
                    <span class="text-toned">message</span>
                    <span class="text-muted">"hey all"</span>
                  </div>
                </div>

                <div class="relative flex items-center gap-0 opacity-70">
                  <div class="h-0 w-8 sm:w-14 border-t border-dashed border-muted/50 shrink-0" />
                  <div class="flex items-center gap-2.5 border border-muted/40 px-3 py-2 font-mono text-xs sm:text-[13px]">
                    <span class="size-1.5 rounded-full border border-muted shrink-0" />
                    <span class="w-8 text-dimmed">{{ outsider.name }}</span>
                    <UIcon name="i-ph-prohibit-duotone" class="size-3.5 text-dimmed" />
                    <span class="text-dimmed">not in #general</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Right: joins are gated by a check you write on the server -->
          <div class="px-5 sm:px-8 py-7 border-t lg:border-t-0 lg:border-l border-muted/50">
            <p class="mb-6 font-mono text-[11px] tracking-wide text-toned">gated join → your check decides</p>
            <div class="flex flex-col items-center gap-2.5">
              <div class="w-full border border-muted bg-elevated/20 px-3 py-2 text-center font-mono text-xs text-toned">
                socket.<span class="text-sky-300">subscribe</span>(<span class="text-emerald-300">'general'</span>, { token })
              </div>
              <UIcon
                name="i-ph-arrow-down-duotone"
                class="size-4 transition-colors duration-300"
                :class="delivered ? 'text-pink-300' : 'text-dimmed'"
              />
              <div
                class="flex w-full items-center justify-center gap-2 border px-3 py-2 font-mono text-xs transition-colors duration-300"
                :class="delivered ? 'border-pink-500/50 bg-pink-500/[0.08]' : 'border-muted'"
              >
                <UIcon name="i-ph-lock-key-duotone" class="size-3.5 text-pink-300 shrink-0" />
                <span class="text-toned">check(token)</span>
                <span class="text-muted">— you write this</span>
              </div>
              <div class="grid w-full grid-cols-2 gap-3 pt-1">
                <div
                  class="border px-3 py-2.5 font-mono text-[11px] transition-all duration-300"
                  :class="delivered ? 'border-emerald-400/45 bg-emerald-500/[0.08]' : 'border-muted/50 opacity-60'"
                >
                  <div class="flex items-center gap-1.5">
                    <UIcon name="i-ph-check-circle-duotone" class="size-3.5 text-emerald-300 shrink-0" />
                    <span class="text-toned">ada</span>
                  </div>
                  <div class="mt-1 text-muted">valid token → joined</div>
                </div>
                <div
                  class="border px-3 py-2.5 font-mono text-[11px] transition-all duration-300"
                  :class="delivered ? 'border-red-400/40 bg-red-500/[0.07]' : 'border-muted/50 opacity-60'"
                >
                  <div class="flex items-center gap-1.5">
                    <UIcon name="i-ph-x-circle-duotone" class="size-3.5 text-red-400 shrink-0" />
                    <span class="text-toned">jo</span>
                  </div>
                  <div class="mt-1 text-muted">bad token → denied</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-muted/60 px-4 py-3 font-mono text-xs text-toned flex items-center gap-2">
          <UIcon name="i-ph-shield-check-duotone" class="size-4 text-emerald-400 shrink-0" />
          membership lives on the server — the broadcast never reaches <span class="text-toned">{{ outsider.name }}</span>
        </div>
      </div>
    </Motion>
  </section>
</template>
