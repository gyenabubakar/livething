<script setup lang="ts">
import { useIntersectionObserver } from '@vueuse/core'

const commands = [
  'pnpm add @livething/server @livething/server-cloudflare @livething/client @livething/core',
  'pnpm wrangler deploy',
]

const heroCta = ref<{ $el: HTMLElement }>()
const heroCtaVisible = useState('hero-cta-visible', () => true)

useIntersectionObserver(() => heroCta.value?.$el, ([entry]) => {
  heroCtaVisible.value = entry?.isIntersecting ?? true
})
onBeforeUnmount(() => { heroCtaVisible.value = true })

const copied = ref(false)

async function copy() {
  await navigator.clipboard.writeText(commands.join(' && '))
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <section class="frame-row grid lg:grid-cols-2 pt-16">
    <div class="flex flex-col justify-center px-6 sm:px-10 py-16 lg:py-24 lg:border-r border-default">
      <p class="section-label">
        LiveThing on Cloudflare
      </p>
      <h1 class="section-title mb-6 leading-[1.05]">
        Your own realtime cloud, on Cloudflare<span class="text-primary">.</span>
      </h1>
      <p class="mb-8 max-w-lg text-base/7 text-muted">
        Rooms, presence and shared documents today, with chat, push notifications, notification feeds and comments coming next, deployed to your own Cloudflare account. Every room runs as a Durable Object in one of 348 cities, and you pay Cloudflare's prices.
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <UButton
          ref="heroCta"
          to="/core/runtimes/adapters/cloudflare"
          size="lg"
          class="glow-button font-medium"
          trailing-icon="i-ph-arrow-right-duotone"
          label="Deploy to Cloudflare"
        />
        <UButton
          to="#the-bill"
          size="lg"
          color="neutral"
          variant="outline"
          label="See what it costs"
          leading-icon="i-ph-receipt-duotone"
        />
      </div>

      <div class="mt-12 max-w-xl border border-default bg-elevated/30">
        <div class="flex items-center border-b border-default font-mono text-xs">
          <span class="px-4 py-2.5 text-highlighted shadow-[inset_0_-1px_0_var(--ui-primary)]">terminal</span>
          <button class="ml-auto px-4 text-muted hover:text-highlighted" :aria-label="copied ? 'Copied' : 'Copy commands'" @click="copy">
            <UIcon :name="copied ? 'i-ph-check' : 'i-ph-copy'" class="size-4" />
          </button>
        </div>
        <pre class="whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-6 text-toned"><template v-for="command in commands" :key="command"><span class="select-none text-primary">$ </span>{{ command }}
</template></pre>
      </div>
    </div>

    <div class="relative flex items-center justify-center px-6 py-10 lg:py-16 overflow-hidden">
      <div class="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_45%,rgb(244_97_15/0.12),transparent)]" aria-hidden="true" />
      <CloudflareRoomsIllustration class="relative max-w-[640px] cursor-default select-none" />
    </div>
  </section>
</template>
