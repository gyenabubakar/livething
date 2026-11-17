<script setup lang="ts">
// One bento cell: copy on top and the illustration below, running to the cell
// edges. A wide cell spans both columns and puts the two side by side; a
// centered cell spans both columns with the copy centred above the art.
const props = defineProps<{
  link?: string
  linkLabel?: string
  wide?: boolean
  centered?: boolean
}>()

const layout = computed(() => {
  if (props.centered) return 'lg:col-span-2'
  return props.wide ? 'lg:col-span-2 lg:grid lg:grid-cols-2' : 'lg:grid lg:grid-rows-subgrid lg:odd:border-r'
})
</script>

<template>
  <article class="frame-row flex min-w-0 flex-col lg:row-span-2" :class="layout">
    <div
      class="px-6 sm:px-10 pt-12 pb-10"
      :class="centered ? 'flex flex-col items-center text-center lg:pt-20 lg:pb-4' : wide ? 'lg:flex lg:flex-col lg:justify-center lg:py-16' : ''"
    >
      <p class="section-label" :class="centered && 'justify-center'">
        <slot name="headline" />
      </p>
      <h2 class="feature-title">
        <slot name="title" /><span class="text-primary">.</span>
      </h2>
      <p class="mt-4 text-base/7 text-muted [&_code]:font-mono [&_code]:text-primary" :class="centered ? 'max-w-2xl' : 'max-w-lg'">
        <slot name="description" />
      </p>
      <NuxtLink v-if="link" :to="link" class="group mt-5 inline-flex items-center gap-1.5 font-mono text-xs text-primary">
        <span class="border-b border-primary/40 pb-0.5 group-hover:border-primary">{{ linkLabel || 'Learn more' }}</span>
        <UIcon name="i-ph-arrow-right" class="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </NuxtLink>
    </div>
    <div class="relative flex-1 min-h-[320px] cursor-default select-none overflow-hidden" :class="wide ? 'lg:min-h-full' : ''">
      <slot name="art" />
    </div>
  </article>
</template>
