<script setup lang="ts">
import type { FooterColumn } from '@nuxt/ui'

const route = useRoute()
const isLanding = computed(() => route.path === '/')

const columns = computed<FooterColumn[]>(() => [
  {
    label: 'Resources',
    children: [
      {
        label: 'Documentation',
        to: '/start/introduction'
      },
      {
        label: 'Releases',
        to: 'https://github.com/plain-software-co/livething/releases',
        target: '_blank'
      },
      {
        label: 'LLMs.txt',
        to: '/llms.txt',
        target: '_blank'
      }
    ]
  },
  {
    label: 'Community',
    children: [
      {
        label: 'GitHub',
        to: 'https://github.com/plain-software-co/livething',
        target: '_blank'
      },
      {
        label: 'Contributing',
        to: 'https://github.com/plain-software-co/livething/blob/main/CONTRIBUTING.md',
        target: '_blank'
      }
    ]
  }
])
</script>

<template>
  <UFooter v-if="!isLanding" :ui="{ top: 'border-b border-default', root: 'z-10 border-t border-default' }">
    <template #top>
      <UContainer>
        <UFooterColumns :columns />
      </UContainer>
    </template>

    <template #left>
      <div class="text-xs font-mono italic tracking-tight">
        <span class="text-muted">&copy; {{ new Date().getFullYear() }} - Made by </span>
        <ULink to="https://gyen.dev/" target="_blank" class="hover:underline">
          Gyen Abubakar</ULink>.
      </div>
    </template>

    <template #right>
      <UButton
        color="neutral"
        variant="ghost"
        to="https://x.com/GyenAbubakar"
        target="_blank"
        icon="i-simple-icons-x"
        size="sm"
        aria-label="X"
      />
      <UButton
        color="neutral"
        variant="ghost"
        to="https://github.com/plain-software-co/livething"
        target="_blank"
        icon="i-simple-icons-github"
        size="sm"
        aria-label="GitHub"
      />
    </template>
  </UFooter>
</template>
