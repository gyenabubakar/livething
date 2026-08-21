<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'

const props = defineProps<{
  item: ContentNavigationItem
  level: number
  isOpen: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const route = useRoute()

const hasChildren = computed(() => Array.isArray(props.item.children) && props.item.children.length > 0)
/**
 * Only leaf items light up. Section parents (with children) keep their neutral
 * style even when one of their descendants is active — the visual signal lives
 * on the matching leaf, not on the breadcrumb chain.
 */
const isActive = computed(() => !hasChildren.value && route.path === props.item.path)

const { isOpen: isChildOpen, toggle: toggleChild } = useSidebarGroupToggle(computed(() => props.item.children ?? []))

const itemClasses = 'flex w-full items-center gap-1.5 px-2.5 py-1.5 pr-2 text-sm transition-colors'
const inactiveClasses = 'text-muted hover:text-default'
const activeClasses = 'text-primary font-medium'
const headerClasses = 'text-default font-medium hover:text-primary'
</script>

<template>
  <li>
    <ULink
      v-if="!hasChildren"
      :to="item.path"
      :class="[itemClasses, isActive ? activeClasses : inactiveClasses]"
    >
      <UIcon
        v-if="typeof item.icon === 'string'"
        :name="item.icon"
        class="size-4 shrink-0"
      />
      <span class="truncate">{{ item.title }}</span>
    </ULink>
    <button
      v-else
      type="button"
      :class="[itemClasses, headerClasses, 'group']"
      :aria-label="isOpen ? `Collapse ${item.title}` : `Expand ${item.title}`"
      :aria-expanded="isOpen"
      @click="emit('toggle')"
    >
      <UIcon
        v-if="typeof item.icon === 'string'"
        :name="item.icon"
        class="size-4 shrink-0"
      />
      <span class="min-w-0 flex-1 truncate text-left">{{ item.title }}</span>
      <UIcon :name="isOpen ? 'i-ph-minus' : 'i-ph-plus'" class="size-3.5 shrink-0 text-dimmed transition-colors group-hover:text-primary" />
    </button>
    <div
      v-if="hasChildren"
      class="grid transition-[grid-template-rows] duration-200 ease-out"
      :class="isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
    >
      <ul class="ml-3 flex flex-col overflow-hidden border-l border-default/60 pl-3">
        <DocsAsideLeftBodyItem
          v-for="(child, index) in item.children"
          :key="child.path ?? `${item.path}-${index}`"
          :item="child"
          :level="level + 1"
          :is-open="isChildOpen(index)"
          @toggle="toggleChild(index)"
        />
      </ul>
    </div>
  </li>
</template>
