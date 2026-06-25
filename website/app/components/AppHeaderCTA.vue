<template>
  <UButton
    v-if="$route.path === '/'"
    label="Get Started"
    to="/start/installation"
    size="sm"
    variant="solid"
    trailing-icon="i-ph-arrow-right-duotone"
    class="hidden text-zinc-950 sm:inline-flex"
  />
</template>
