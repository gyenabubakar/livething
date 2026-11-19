<script setup lang="ts">
// Shown on the landing page only. The hero has its own "Start building" button,
// so this one fades in once that button has scrolled out of view.
const route = useRoute()
const heroCtaVisible = useState('hero-cta-visible', () => true)
const hidden = computed(() => heroCtaVisible.value)
</script>

<template>
  <UButton
    v-if="route.path === '/'"
    label="Get Started"
    to="/core/start/installation"
    size="sm"
    variant="solid"
    trailing-icon="i-ph-arrow-right-duotone"
    class="hidden text-zinc-950 transition duration-300 sm:inline-flex"
    :class="hidden ? 'pointer-events-none translate-y-1 opacity-0' : 'opacity-100'"
    :aria-hidden="hidden || undefined"
    :tabindex="hidden ? -1 : undefined"
  />
</template>
