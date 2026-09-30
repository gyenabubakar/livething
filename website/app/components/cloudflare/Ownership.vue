<script setup lang="ts">
const points = [
  {
    icon: 'i-ph-vault-duotone',
    title: 'Your account, your data',
    body: 'Messages, presence, feeds and documents sit in SQLite inside your own Durable Objects. No realtime vendor keeps a copy, so there is no extra data processor to list or audit.',
    code: 'ctx.sql.exec(\'SELECT * FROM messages\')',
  },
  {
    icon: 'i-ph-globe-hemisphere-west-duotone',
    title: 'Kept in the right region',
    body: 'Create a room inside the EU jurisdiction, and Cloudflare stores and runs it only in the EU. Rooms without a rule start close to the people who use them.',
    code: 'env.CHAT_ROOM.jurisdiction(\'eu\')',
  },
  {
    icon: 'i-ph-user-minus-duotone',
    title: 'Delete a person in one call',
    body: 'One admin call removes a user\'s memberships, inbox, read receipts, last-seen time and streams, then closes their sockets. Deletion requests take seconds.',
    code: 'await admin.purgeUser(userId)',
  },
]
</script>

<template>
  <section>
    <div class="frame-row px-6 sm:px-10 py-16">
      <p class="section-label">
        Ownership
      </p>
      <h2 class="section-title max-w-3xl">
        No vendor between you and your users<span class="text-primary">.</span>
      </h2>
    </div>

    <div class="frame-row grid lg:grid-cols-3">
      <article
        v-for="(point, index) in points"
        :key="point.title"
        class="flex flex-col px-6 sm:px-10 py-12 border-default"
        :class="index < points.length - 1 && 'max-lg:border-b lg:border-r'"
      >
        <UIcon :name="point.icon" class="size-7 text-primary" />
        <h3 class="feature-title mt-6 text-2xl!">
          {{ point.title }}<span class="text-primary">.</span>
        </h3>
        <p class="mt-4 flex-1 text-sm/6 text-muted">
          {{ point.body }}
        </p>
        <code class="mt-8 w-fit border border-default bg-elevated/40 px-3 py-2 font-mono text-xs text-toned">{{ point.code }}</code>
      </article>
    </div>
  </section>
</template>
