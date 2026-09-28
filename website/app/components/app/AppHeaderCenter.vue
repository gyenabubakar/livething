<script setup lang="ts">
const route = useRoute()
const isHome = computed(() => route.path === '/')

const landingItems = [
  {
    label: 'Start',
    to: '/start/overview',
    children: [
      {
        label: 'Introduction',
        icon: 'i-ph-hand-waving-duotone',
        description: 'Two packages, one typed contract',
        to: '/start/introduction'
      },
      {
        label: 'What is WebSocket?',
        icon: 'i-ph-plugs-connected-duotone',
        description: 'A primer on the protocol underneath',
        to: '/start/what-is-websocket'
      },
      {
        label: 'Why LiveThing',
        icon: 'i-ph-lightbulb-duotone',
        description: 'What you stop hand-building',
        to: '/start/why-livething'
      },
      {
        label: 'Installation',
        icon: 'i-ph-download-simple-duotone',
        description: 'Client, server, and an adapter',
        to: '/start/installation'
      },
      {
        label: 'Quickstart',
        icon: 'i-ph-lightning-duotone',
        description: 'A tiny end-to-end app in minutes',
        to: '/start/quickstart'
      }
    ]
  },
  {
    label: 'Learn',
    to: '/learn/overview',
    children: [
      {
        label: 'The Contract',
        icon: 'i-ph-scroll-duotone',
        description: 'One inferred type, both sides',
        to: '/learn/the-contract'
      },
      {
        label: 'Capabilities & Primitives',
        icon: 'i-ph-puzzle-piece-duotone',
        description: 'The matched opt-in pair',
        to: '/learn/capabilities-and-primitives'
      },
      {
        label: 'Messaging',
        icon: 'i-ph-chat-circle-dots-duotone',
        description: 'Events, requests, errors, validation',
        to: '/learn/messaging'
      },
      {
        label: 'Channels',
        icon: 'i-ph-users-three-duotone',
        description: 'Server-managed rooms with auth',
        to: '/learn/channels'
      },
      {
        label: 'Streaming',
        icon: 'i-ph-waveform-duotone',
        description: 'Progressive, chunked data',
        to: '/learn/streaming'
      },
      {
        label: 'Reliability',
        icon: 'i-ph-pulse-duotone',
        description: 'Reconnection, keepalive, replay',
        to: '/learn/reliability'
      },
      {
        label: 'Identity & Access',
        icon: 'i-ph-key-duotone',
        description: 'Auth, tags, and rate limiting',
        to: '/learn/identity-and-access'
      }
    ]
  },
  {
    label: 'Server',
    to: '/server/overview',
    children: [
      {
        label: 'server()',
        icon: 'i-ph-brackets-curly-duotone',
        description: 'The builder and assemble',
        to: '/server/server/overview'
      },
      {
        label: 'Adapters',
        icon: 'i-ph-plugs-duotone',
        description: 'Run the definition on a platform',
        to: '/server/adapters/overview'
      },
      {
        label: 'Capabilities',
        icon: 'i-ph-puzzle-piece-duotone',
        description: 'The opt-in feature catalog',
        to: '/server/capabilities/overview'
      },
      {
        label: 'Handlers',
        icon: 'i-ph-brackets-angle-duotone',
        description: 'on, request, stream, scheduled',
        to: '/server/handlers/overview'
      },
      {
        label: 'Channels',
        icon: 'i-ph-users-three-duotone',
        description: 'Rooms, the auth gate, families',
        to: '/server/channels/overview'
      },
      {
        label: 'Streams',
        icon: 'i-ph-waveform-duotone',
        description: 'Plain, durable, and broadcast',
        to: '/server/streams/overview'
      },
      {
        label: 'Replay',
        icon: 'i-ph-clock-counter-clockwise-duotone',
        description: 'Catch up after a disconnect',
        to: '/server/replay/overview'
      },
      {
        label: 'Plugins',
        icon: 'i-ph-plug-duotone',
        description: 'Package a reusable feature',
        to: '/server/plugins/overview'
      },
      {
        label: 'Under the hood',
        icon: 'i-ph-gear-duotone',
        description: 'The engine and pipeline order',
        to: '/server/under-the-hood/overview'
      }
    ]
  },
  {
    label: 'Client',
    to: '/client/overview',
    children: [
      {
        label: 'Connecting',
        icon: 'i-ph-plugs-connected-duotone',
        description: 'Options, dynamic URLs, auth, SSR',
        to: '/client/connecting/overview'
      },
      {
        label: 'Primitives',
        icon: 'i-ph-puzzle-piece-duotone',
        description: 'Every built-in client primitive',
        to: '/client/primitives/overview'
      },
      {
        label: 'Channels',
        icon: 'i-ph-users-three-duotone',
        description: 'Handles, families, and presence',
        to: '/client/channels/overview'
      },
      {
        label: 'Streams',
        icon: 'i-ph-waveform-duotone',
        description: 'Consume, nudge, resume, broadcast',
        to: '/client/streams/overview'
      },
      {
        label: 'Errors',
        icon: 'i-ph-warning-duotone',
        description: 'How errors surface and narrow',
        to: '/client/errors/overview'
      }
    ]
  }
]
</script>

<template>
  <UNavigationMenu
    v-if="isHome"
    class="mx-auto"
    variant="link"
    color="neutral"
    :items="landingItems"
    :ui="{
      linkTrailingIcon: 'hidden',
      childLink: 'hover:bg-elevated/50',
      viewport: 'bg-default backdrop-blur-xl ring ring-offset-6 ring-offset-bg ring-default border border-default',
      viewportWrapper: 'w-[600px] transition-all duration-500 left-1/2 -translate-x-1/2',
    }"
  />
  <UContentSearchButton
    v-else
    :collapsed="false"
    class="w-full"
    variant="soft"
    :ui="{ leadingIcon: 'size-4 mr-1' }"
  />
</template>
