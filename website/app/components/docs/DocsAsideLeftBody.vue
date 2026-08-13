<script setup lang="ts">
/**
 * Local override of the Docus DocsAsideLeftBody.
 *
 * Reason: the upstream component renders the sidebar with `UContentNavigation`,
 * whose reka-ui Accordion doesn't give per-level control over which group
 * starts open. We render a flat recursive nav instead, with our own
 * exclusive-open toggle per level (see `useSidebarGroupToggle`).
 */
const { sidebarNavigation } = useSubNavigation()
const { isOpen, toggle } = useSidebarGroupToggle(sidebarNavigation)
</script>

<template>
  <nav class="-mr-6.5">
    <ul class="flex flex-col">
      <DocsAsideLeftBodyItem
        v-for="(item, index) in sidebarNavigation"
        :key="item.path ?? `root-${index}`"
        :item
        :level="0"
        :is-open="isOpen(index)"
        @toggle="toggle(index)"
      />
    </ul>
  </nav>
</template>
