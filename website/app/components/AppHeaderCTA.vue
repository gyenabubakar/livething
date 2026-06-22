<template>
  <UButton
    v-if="$route.path === '/'"
    label="Get Started"
    to="/start/introduction"
    size="sm"
    variant="solid"
    trailing-icon="i-ph-arrow-right-duotone"
    class="hidden text-white sm:inline-flex"
  />
</template>
