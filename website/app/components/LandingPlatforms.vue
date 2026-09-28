<script setup lang="ts">
// `mono` logos are one-colour marks drawn in the text colour through a mask,
// so they suit both themes. The rest are full-colour images.
interface Platform { name: string, src: string, mono?: boolean, white?: boolean }

const platforms: Platform[] = [
  { name: 'JavaScript', src: '/logos/js.svg' },
  { name: 'React', src: '/logos/react.svg' },
  { name: 'React Native', src: '/logos/react.svg' },
  { name: 'Vue', src: '/logos/vue.svg' },
  { name: 'Svelte', src: '/logos/svelte.svg' },
  { name: 'Solid', src: '/logos/solidjs.svg' },
  { name: 'Nuxt', src: '/logos/nuxt.svg' },
  { name: 'SvelteKit', src: '/logos/svelte.svg' },
  { name: 'SolidStart', src: '/logos/solidjs.svg' },
  { name: 'TanStack Start', src: '/logos/tanstack.svg', mono: true },
  { name: 'React Router', src: '/logos/react-router.svg', mono: true },
  { name: 'Astro', src: '/logos/astro.svg', white: true },
  { name: 'Hono', src: '/logos/hono.svg' },
  { name: 'Express', src: '/logos/express.svg', mono: true },
  { name: 'Fastify', src: '/logos/fastify.svg', mono: true },
  { name: 'Koa', src: '/logos/koa.svg', mono: true },
  { name: 'h3', src: '/logos/h3.svg', mono: true },
  { name: 'Node.js', src: '/logos/nodejs.svg' },
  { name: 'Bun', src: '/logos/bun.svg' },
  { name: 'Deno', src: '/logos/deno.svg', white: true },
  { name: 'Cloudflare', src: '/logos/cloudflare.svg' },
]
</script>

<template>
  <section class="frame-row flex items-center">
    <p class="shrink-0 px-6 sm:px-10 py-5 text-xs font-medium uppercase tracking-widest text-zinc-500">
      Works with
    </p>
    <div class="platforms-track relative min-w-0 flex-1 overflow-hidden py-5">
      <!-- The list is drawn twice so the loop has no seam; the copy is hidden from screen readers. -->
      <ul v-for="copy in 2" :key="copy" class="platforms-list" :aria-hidden="copy === 2 || undefined">
        <li v-for="item in platforms" :key="item.name" class="group flex shrink-0 items-center gap-2 text-sm text-muted transition-colors hover:text-highlighted">
          <span
            v-if="item.mono"
            class="size-5 bg-current"
            :style="{ mask: `url(${item.src}) center / contain no-repeat` }"
            aria-hidden="true"
          />
          <img
            v-else
            :src="item.src"
            alt=""
            class="size-5 object-contain opacity-70 grayscale transition group-hover:opacity-100 group-hover:grayscale-0"
            :class="item.white && 'logo-white'"
          >
          {{ item.name }}
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.platforms-track {
  display: flex;
  mask-image: linear-gradient(90deg, transparent, black 6%, black 94%, transparent);
}

.platforms-list {
  display: flex;
  flex-shrink: 0;
  gap: 2.25rem;
  padding-right: 2.25rem;
  animation: platforms-scroll 50s linear infinite;
}

.platforms-track:hover .platforms-list {
  animation-play-state: paused;
}

@keyframes platforms-scroll {
  to { transform: translateX(-100%); }
}

@media (prefers-reduced-motion: reduce) {
  .platforms-track {
    mask-image: none;
  }

  .platforms-list {
    animation: none;
    flex-wrap: wrap;
    flex-shrink: 1;
    row-gap: 0.75rem;
  }

  .platforms-list[aria-hidden] {
    display: none;
  }
}
</style>
