<script setup lang="ts">
import { useIntersectionObserver } from '@vueuse/core'

// Deno runs the Node.js adapter.
const runtimes = [
  { name: 'Node.js', icon: 'i-simple-icons-nodedotjs', install: 'npm i', adapter: '@livething/server-node' },
  { name: 'Deno', icon: 'i-simple-icons-deno', install: 'npm i', adapter: '@livething/server-node' },
  { name: 'Bun', icon: 'i-simple-icons-bun', install: 'bun add', adapter: '@livething/server-bun' },
  { name: 'Cloudflare', icon: 'i-simple-icons-cloudflare', install: 'npm i', adapter: '@livething/server-cloudflare' },
].map(runtime => ({
  name: runtime.name,
  icon: runtime.icon,
  command: `${runtime.install} @livething/server ${runtime.adapter} @livething/client @livething/core`,
}))
const heroCta = ref<{ $el: HTMLElement }>()
const heroCtaVisible = useState('hero-cta-visible', () => true)

useIntersectionObserver(() => heroCta.value?.$el, ([entry]) => {
  heroCtaVisible.value = entry?.isIntersecting ?? true
})
onBeforeUnmount(() => { heroCtaVisible.value = true })

const active = ref(0)
const copied = ref(false)

async function copy() {
  await navigator.clipboard.writeText(runtimes[active.value]!.command)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <section class="frame-row grid grid-cols-1 lg:grid-cols-2 pt-16">
    <div class="flex flex-col justify-center px-6 sm:px-10 py-16 lg:py-24 lg:border-r border-default">
      <h1 class="section-title mb-6 leading-[1.05]">
        <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
      </h1>
      <p class="mb-8 max-w-lg text-base/7 text-muted">
        <slot name="description" mdc-unwrap="p" />
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <UButton
          ref="heroCta"
          to="/core/start/installation"
          size="lg"
          class="glow-button font-medium"
          trailing-icon="i-ph-arrow-right-duotone"
          label="Start building"
        />
        <UButton
          to="https://github.com/workmatter/livething"
          target="_blank"
          size="lg"
          color="neutral"
          variant="outline"
          label="View on GitHub"
          leading-icon="i-simple-icons-github"
        />
      </div>

      <div class="mt-12 w-full min-w-0 max-w-xl border border-default bg-elevated/30">
        <div class="flex border-b border-default font-mono text-xs">
          <div class="flex min-w-0 overflow-x-auto" role="tablist">
          <button
            v-for="(runtime, index) in runtimes"
            :key="runtime.name"
            role="tab"
            :aria-selected="active === index"
            class="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 transition-colors"
            :class="active === index ? 'text-highlighted shadow-[inset_0_-1px_0_var(--ui-primary)]' : 'text-muted hover:text-toned'"
            @click="active = index"
          >
            <UIcon :name="runtime.icon" class="size-3.5" aria-hidden="true" />
            {{ runtime.name }}
          </button>
          </div>
          <button class="ml-auto shrink-0 px-4 text-muted hover:text-highlighted" :aria-label="copied ? 'Copied' : 'Copy install command'" @click="copy">
            <UIcon :name="copied ? 'i-ph-check' : 'i-ph-copy'" class="size-4" />
          </button>
        </div>
        <pre class="overflow-x-scroll whitespace-pre px-4 py-3 font-mono text-xs leading-6 text-toned">{{ runtimes[active]!.command }}</pre>
      </div>
    </div>

    <div class="relative flex items-center justify-center px-6 py-10 lg:py-16 overflow-hidden">
      <div class="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_45%,rgb(244_97_15/0.12),transparent)]" aria-hidden="true" />
      <LandingHeroIllustration class="relative max-w-[640px] cursor-default select-none" />
    </div>
  </section>
</template>
