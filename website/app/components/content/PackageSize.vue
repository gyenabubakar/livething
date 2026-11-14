<script setup lang="ts">
// Markdown writes :package-size{id="client.minimal"}, or :package-size{id="client.minimal" code} for a code chip.
const props = defineProps<{ id: string; code?: boolean }>()
const text = computed(() => formatPackageSize(packageSize(props.id)))
</script>

<template>
  <ProseCode v-if="props.code">{{ text }}</ProseCode>
  <span v-else>{{ text }}</span>
</template>
