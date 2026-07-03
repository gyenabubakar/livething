<script setup lang="ts">
import { useSubNavigation, useUIConfig } from '#imports'

const { sections } = useSubNavigation()
const navMenuVariants = useUIConfig('navigationMenu')

const llmsItems = [
  [
    {
      label: 'llms.txt',
      icon: 'i-ph-list-bullets-duotone',
      to: '/llms.txt',
      target: '_blank',
    },
    {
      label: 'llms-full.txt',
      icon: 'i-ph-files-duotone',
      to: '/llms-full.txt',
      target: '_blank',
    },
  ],
]
</script>

<template>
  <USeparator class="hidden lg:flex" />

  <UContainer class="hidden lg:flex items-center justify-between">
    <UNavigationMenu
      :items="sections"
      :highlight="navMenuVariants.highlight ?? true"
      :highlight-color="navMenuVariants.highlightColor"
      :variant="navMenuVariants.variant ?? 'pill'"
      :color="navMenuVariants.color"
      class="-mx-2.5 -mb-px"
    />

    <UDropdownMenu
      :items="llmsItems"
      :content="{ align: 'end', sideOffset: 8 }"
    >
      <UButton
        label="llms.txt"
        icon="i-ph-robot-duotone"
        trailing-icon="i-lucide-chevron-down"
        color="neutral"
        variant="ghost"
        :ui="{ label: 'text-sm' }"
      />
    </UDropdownMenu>
  </UContainer>
</template>
