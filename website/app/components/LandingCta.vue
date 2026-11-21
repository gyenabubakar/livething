<template>
  <section>
    <LandingGrainPanel class="frame-row">
      <div class="mx-auto max-w-2xl px-6 py-24 md:py-32 text-center">
        <h2 class="section-title text-white!">
          <slot name="title">Typed realtime,<br>on your own servers</slot><span class="cta-dot">.</span>
        </h2>
        <p class="mt-6 mb-10 text-base/7 text-white/85">
          <slot name="description" mdc-unwrap="p" />
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <UButton to="/core/start/installation" size="lg" class="bg-zinc-950 text-white hover:bg-zinc-800" trailing-icon="i-ph-arrow-right-duotone" label="Get started" />
          <UButton
            to="https://github.com/gyenabubakar/livething"
            target="_blank"
            size="lg"
            class="border border-white/50 bg-white/10 text-white hover:bg-white/20"
            leading-icon="i-simple-icons-github"
            label="View on GitHub"
          />
        </div>
      </div>
    </LandingGrainPanel>

    <footer class="px-6 sm:px-10 py-6 font-mono text-xs italic tracking-tight text-muted">
      <div class="flex items-center justify-between">
        <NuxtLink to="/" aria-label="LiveThing home" class="flex items-center gap-1.5 not-italic text-highlighted">
          <AppLogoMark class="h-4 w-auto" />
          <span class="font-serif text-base font-semibold tracking-tight">livething<span class="text-primary">.</span></span>
        </NuxtLink>
        <div class="flex items-center gap-3">
          <a href="https://x.com/GyenAbubakar" target="_blank" rel="noopener noreferrer" aria-label="X" class="hover:text-highlighted">
            <UIcon name="i-simple-icons-x" class="size-4" />
          </a>
          <a href="https://github.com/gyenabubakar/livething" target="_blank" rel="noopener noreferrer" aria-label="GitHub" class="hover:text-highlighted">
            <UIcon name="i-simple-icons-github" class="size-4" />
          </a>
        </div>
      </div>
      <div class="mt-4 flex flex-col gap-1 border-t border-default pt-4 sm:flex-row sm:justify-between sm:gap-4">
        <p>
          &copy; {{ new Date().getFullYear() }} - Made by
          <a href="https://gyen.dev/" target="_blank" rel="noopener noreferrer" class="hover:underline">Gyen Abubakar</a>
        </p>
        <p>
          Logo by <a href="https://charlesarthur.framer.website/" target="_blank" rel="noopener noreferrer" class="hover:underline">Charles Arthur</a>.
        </p>
      </div>
    </footer>
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
