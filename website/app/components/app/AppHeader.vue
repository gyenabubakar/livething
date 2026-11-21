<script setup lang="ts">
import { useSubNavigation } from '#imports'

const appConfig = useAppConfig()
const site = useSiteConfig()
const { isEnabled: isAssistantEnabled } = useAssistant()
const { subNavigationMode } = useSubNavigation()

const isHome = useMarketingPage()
const links = computed(() => appConfig.github?.url
  ? [
    {
      'icon': 'i-simple-icons-github',
      'to': appConfig.github.url,
      'target': '_blank',
      'aria-label': 'GitHub',
    },
  ]
  : [])

// On docs pages the left slot (logo and track tabs) sizes to its content, and the empty
// center takes the slack, which pushes search to the right.
const headerUi = computed(() => isHome.value
  ? { root: 'fixed inset-x-0 top-0 z-50', center: 'flex-1' }
  : { left: 'lg:flex-none', center: 'flex-1' })

</script>

<template>
  <UHeader
    :ui="headerUi"
    :class="{ 'flex flex-col': subNavigationMode === 'header' }"
    to="/"
    :title="appConfig.header?.title || site.name"
  >
    <AppHeaderCenter />

    <template #title>
      <AppHeaderLogo class="h-6 w-auto shrink-0" />
    </template>

    <template
      v-if="!isHome"
      #left
    >
      <ULink
        to="/"
        aria-label="LiveThing home"
        class="flex shrink-0 items-center"
      >
        <AppHeaderLogo class="h-6 w-auto shrink-0" />
      </ULink>
      <USeparator
        orientation="vertical"
        class="mx-4 hidden h-6 lg:block"
      />
      <AppHeaderTracks class="hidden lg:flex" />
    </template>

    <template #right>
      <AppHeaderCTA />

      <template v-if="isAssistantEnabled">
        <AssistantChat />
      </template>

      <UContentSearchButton
        :class="{ 'sm:hidden': !isHome }"
        aria-label="Search documentation"
      />
      <UContentSearchButton
        v-if="!isHome"
        :collapsed="false"
        variant="soft"
        class="hidden w-56 sm:flex lg:w-64"
        aria-label="Search documentation"
      />

      <template v-if="links?.length">
        <UButton
          v-for="(link, index) of links"
          :key="index"
          v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
        />
      </template>
    </template>

    <template #toggle="{ open, toggle }">
      <IconMenuToggle
        :open
        class="lg:hidden"
        @click="toggle"
      />
    </template>

    <template #body>
      <AppHeaderTracks
        v-if="!isHome"
        class="mb-4"
      />
      <AppHeaderBody />
    </template>

    <template
      v-if="subNavigationMode === 'header'"
      #bottom
    >
      <AppHeaderBottom />
    </template>
  </UHeader>
</template>
