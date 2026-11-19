<script setup lang="ts">
import Chat from './plugin-mocks/Chat.vue'
import Collab from './plugin-mocks/Collab.vue'
import Feed from './plugin-mocks/Feed.vue'
import Push from './plugin-mocks/Push.vue'
import State from './plugin-mocks/State.vue'

// One animated preview per first-party plugin. Each preview plays only while it
// is on screen.
const mocks = {
  chat: Chat,
  push: Push,
  collab: Collab,
  feed: Feed,
  state: State,
}

defineProps<{ kind: keyof typeof mocks }>()
</script>

<template>
  <component :is="mocks[kind]" aria-hidden="true" />
</template>
