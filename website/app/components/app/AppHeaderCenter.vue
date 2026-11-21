<script setup lang="ts">
const route = useRoute()
const isHome = computed(() => route.path === '/')

const landingItems = [
  {
    label: 'Start',
    to: '/core/start/introduction',
    children: [
      {
        label: 'Introduction',
        icon: 'i-ph-hand-waving-duotone',
        description: 'Two packages, one typed contract',
        to: '/core/start/introduction'
      },
      {
        label: 'What is WebSocket?',
        icon: 'i-ph-plugs-connected-duotone',
        description: 'A primer on the protocol underneath',
        to: '/core/start/what-is-websocket'
      },
      {
        label: 'Why LiveThing',
        icon: 'i-ph-lightbulb-duotone',
        description: 'What you stop hand-building',
        to: '/core/start/why-livething'
      },
      {
        label: 'Installation',
        icon: 'i-ph-download-simple-duotone',
        description: 'Client, server, and an adapter',
        to: '/core/start/installation'
      },
      {
        label: 'Quickstart',
        icon: 'i-ph-lightning-duotone',
        description: 'A tiny end-to-end app in minutes',
        to: '/core/start/quickstart'
      }
    ]
  },
  {
    label: 'Server',
    to: '/core/server/overview',
    children: [
      {
        label: 'server()',
        icon: 'i-ph-brackets-curly-duotone',
        description: 'The builder and assemble',
        to: '/core/server/server/overview'
      },
      {
        label: 'Capabilities',
        icon: 'i-ph-puzzle-piece-duotone',
        description: 'The opt-in feature catalog',
        to: '/core/server/capabilities/overview'
      },
      {
        label: 'Handlers',
        icon: 'i-ph-brackets-angle-duotone',
        description: 'on, request, stream, scheduled',
        to: '/core/server/handlers/overview'
      },
      {
        label: 'Channels',
        icon: 'i-ph-users-three-duotone',
        description: 'Rooms, the auth gate, families',
        to: '/core/server/channels/overview'
      },
      {
        label: 'Streams',
        icon: 'i-ph-waveform-duotone',
        description: 'Plain, durable, and broadcast',
        to: '/core/server/streams/overview'
      },
      {
        label: 'Replay',
        icon: 'i-ph-clock-counter-clockwise-duotone',
        description: 'Catch up after a disconnect',
        to: '/core/server/replay/overview'
      },
      {
        label: 'Plugins',
        icon: 'i-ph-plug-duotone',
        description: 'Package a reusable feature',
        to: '/core/server/plugins/overview'
      },
      {
        label: 'Under the hood',
        icon: 'i-ph-gear-duotone',
        description: 'The engine and pipeline order',
        to: '/core/server/under-the-hood/overview'
      }
    ]
  },
  {
    label: 'Client',
    to: '/core/client/overview',
    children: [
      {
        label: 'Connecting',
        icon: 'i-ph-plugs-connected-duotone',
        description: 'Options, dynamic URLs, auth, SSR',
        to: '/core/client/connecting/overview'
      },
      {
        label: 'Transports',
        icon: 'i-ph-arrows-left-right-duotone',
        description: 'WebSocket, http(), and failover',
        to: '/core/client/transports/overview'
      },
      {
        label: 'Primitives',
        icon: 'i-ph-puzzle-piece-duotone',
        description: 'Every built-in client primitive',
        to: '/core/client/primitives/overview'
      },
      {
        label: 'Channels',
        icon: 'i-ph-users-three-duotone',
        description: 'Handles, families, and presence',
        to: '/core/client/channels/overview'
      },
      {
        label: 'Streams',
        icon: 'i-ph-waveform-duotone',
        description: 'Consume, nudge, continue, broadcast',
        to: '/core/client/streams/overview'
      },
      {
        label: 'Errors',
        icon: 'i-ph-warning-duotone',
        description: 'How errors surface and narrow',
        to: '/core/client/errors/overview'
      }
    ]
  },
  {
    label: 'Plugins',
    to: '/plugins/collaboration/overview',
    children: [
      {
        label: 'Chat',
        icon: 'i-ph-chats-circle-duotone',
        description: 'Rooms, threads and history',
        to: '/plugins/chat/overview'
      },
      {
        label: 'Push Notifications',
        icon: 'i-ph-bell-ringing-duotone',
        description: 'Reach people when their socket is closed',
        to: '/plugins/push-notifications/overview'
      },
      {
        label: 'Collaboration',
        icon: 'i-ph-users-four-duotone',
        description: 'Shared documents and state many people edit',
        to: '/plugins/collaboration/overview'
      },
      {
        label: 'Notifications Feed',
        icon: 'i-ph-tray-arrow-down-duotone',
        description: 'An in-app inbox in sync on every device',
        to: '/plugins/notifications-feed/overview'
      },
      {
        label: 'Comments',
        icon: 'i-ph-chat-teardrop-text-duotone',
        description: 'Threads on messages, files and documents',
        to: '/plugins/comments/overview'
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
</template>
