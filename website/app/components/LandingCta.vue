<script setup lang="ts">
import { Motion } from 'motion-v'
</script>

<template>
  <section class="relative overflow-hidden flex flex-col">
    <div
      class="absolute inset-x-0 top-0 h-24 z-[1] pointer-events-none"
      style="background: linear-gradient(180deg, #09090b 0%, transparent 100%)"
    />

    <div
      class="absolute inset-0"
      style="background: linear-gradient(180deg, #09090b 0%, #110600 6%, #331400 14%, #662900 22%, #cc5200 32%, #ff6a00 42%, #ff8420 52%, #ff9d44 62%, #ffbb77 72%, #ffd4a0 80%, #ffe6c8 88%, #fff3e6 94%, #FFFFFF 100%)"
    />

    <div class="relative z-10 pt-24 md:pt-32 text-center max-w-2xl mx-auto px-6">
      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5 }"
        :in-view-options="{ once: true }"
      >
        <div>
          <div class="relative mb-6">
            <h2 class="section-title text-center text-shadow-lg text-shadow-black">
              Real-time,<br>finally typed<span class="cta-dot">.</span>
            </h2>
          </div>
          <p class="text-base leading-relaxed text-highlighted mb-10">
            <slot name="description" mdc-unwrap="p" />
          </p>

          <div class="flex flex-wrap items-center justify-center gap-4">
            <UButton
              to="/start/installation"
              size="lg"
              class="bg-white hover:bg-white/90 text-black border-0"
            >
              Get Started
              <template #trailing>
                <UIcon name="i-ph-arrow-right-duotone" class="size-4" />
              </template>
            </UButton>
            <UButton
              to="https://github.com/plain-software-co/wskit"
              target="_blank"
              size="lg"
              class="bg-white/10 border border-white/40 text-white hover:bg-white/20 backdrop-blur-sm"
            >
              <template #leading>
                <UIcon name="i-simple-icons-github" class="size-4" />
              </template>
              View on GitHub
            </UButton>
          </div>
        </div>
      </Motion>
    </div>

    <div class="relative z-10 mt-auto pt-32 md:pt-44 pb-4">
      <div class="max-w-4xl mx-auto px-6">
        <div class="flex items-center justify-between">
          <div class="text-xs font-mono italic tracking-tight text-muted">
            &copy; {{ new Date().getFullYear() }} - Made by
            <a href="https://gyen.dev/" target="_blank" rel="noopener noreferrer" class="hover:underline text-muted">Gyen Abubakar</a>
          </div>
          <div class="flex items-center gap-3">
            <a href="https://x.com/GyenAbubakar" target="_blank" rel="noopener noreferrer" aria-label="X" class="text-muted hover:text-dimmed transition-colors">
              <UIcon name="i-simple-icons-x" class="size-4" />
            </a>
            <a href="https://github.com/plain-software-co/wskit" target="_blank" rel="noopener noreferrer" aria-label="GitHub" class="text-muted hover:text-dimmed transition-colors">
              <UIcon name="i-simple-icons-github" class="size-4" />
            </a>
          </div>
        </div>
        <div class="mt-4 flex flex-col gap-1 border-t border-black/10 pt-4 text-xs font-mono italic tracking-tight text-muted sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p>
            This website was built from <a href="https://github.com/HugoRCD" target="_blank" rel="noopener noreferrer" class="hover:underline text-muted">HugoRCD</a>'s <a href="https://evlog.dev" target="_blank" rel="noopener noreferrer" class="hover:underline text-muted">evlog</a> website.
          </p>
          <p>
            Logo by <a href="https://charlesarthur.framer.website/" target="_blank" rel="noopener noreferrer" class="hover:underline text-muted">Charles Arthur</a>.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cta-dot {
  animation: pulse-dot 1s steps(1) infinite;
}

@keyframes pulse-dot {
  0%, 45% { opacity: 1; }
  50%, 95% { opacity: 0; }
  100% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .cta-dot {
    animation: none;
  }
}
</style>
