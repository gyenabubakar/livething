<script setup lang="ts">
import Chat from './plugin-mocks/Chat.vue'
import Collab from './plugin-mocks/Collab.vue'
import Cursors from './plugin-mocks/Cursors.vue'
import Feed from './plugin-mocks/Feed.vue'
import Presence from './plugin-mocks/Presence.vue'
import Push from './plugin-mocks/Push.vue'
import State from './plugin-mocks/State.vue'
import Streams from './plugin-mocks/Streams.vue'

// One animated preview per first-party plugin, shared by the landing page and
// the Cloudflare page. Each preview plays only while it is on screen.
const mocks = {
  presence: Presence,
  chat: Chat,
  feed: Feed,
  push: Push,
  collab: Collab,
  cursors: Cursors,
  state: State,
  streams: Streams,
}

defineProps<{ kind: keyof typeof mocks }>()
</script>

<template>
  <component :is="mocks[kind]" aria-hidden="true" />
</template>
