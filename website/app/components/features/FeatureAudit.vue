<script setup lang="ts">
import { Motion } from 'motion-v'

const props = defineProps<{
  link?: string
  linkLabel?: string
}>()

const pills = [
  { label: 'log.audit()', icon: 'i-ph-shield-check-duotone' },
  { label: 'auditOnly()', icon: 'i-ph-funnel-duotone' },
  { label: 'signed()', icon: 'i-ph-fingerprint-duotone' },
  { label: 'auditDiff()', icon: 'i-ph-git-diff-duotone' },
  { label: 'mockAudit()', icon: 'i-ph-flask-duotone' },
]

const benefits = [
  {
    icon: 'i-ph-shield-check-duotone',
    title: 'Reserved schema',
    text: 'Typed action, actor, target, outcome, changes, causation. No magic strings.',
  },
  {
    icon: 'i-ph-fingerprint-duotone',
    title: 'Tamper-evident',
    text: 'HMAC signatures or hash-chain integrity composable on any drain.',
  },
  {
    icon: 'i-ph-arrow-counter-clockwise-duotone',
    title: 'Safe retries',
    text: 'Deterministic idempotency keys auto-derived per audit event.',
  },
  {
    icon: 'i-ph-key-duotone',
    title: 'Compose, do not replace',
    text: 'Reuses your drains, enrichers, redact, sampling. No parallel pipeline.',
  },
]

</script>

<template>
  <section class="py-24 md:py-32">
    <div class="grid gap-6 lg:grid-cols-2 *:min-w-0">
      <div class="flex flex-col gap-6">
        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5 }"
          :in-view-options="{ once: true }"
        >
          <div>
            <p v-if="$slots.headline" class="section-label">
              <slot name="headline" mdc-unwrap="p" />
            </p>
            <div class="relative mb-4">
              <h2 class="section-title">
                <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
              </h2>
              <div aria-hidden="true" class="absolute inset-0 section-title blur-xs animate-pulse pointer-events-none">
                <slot name="title" mdc-unwrap="p" /><span class="text-primary">.</span>
              </div>
            </div>
            <p v-if="$slots.description" class="max-w-md text-sm leading-relaxed text-muted">
              <slot name="description" mdc-unwrap="p" />
            </p>
            <div class="mt-5 flex flex-wrap gap-2">
              <span
                v-for="pill in pills"
                :key="pill.label"
                class="inline-flex items-center gap-1.5 border border-muted bg-elevated/50 px-3 py-1 font-mono text-[11px] text-muted"
              >
                <UIcon :name="pill.icon" class="size-3 text-emerald-500" />
                {{ pill.label }}
              </span>
            </div>
            <NuxtLink v-if="props.link" :to="props.link" class="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-dimmed hover:text-primary transition-colors">
              {{ props.linkLabel || 'Learn more' }}
              <UIcon name="i-ph-arrow-right-duotone" class="size-3" />
            </NuxtLink>
          </div>
        </Motion>

        <Motion
          :initial="false"
          :while-in-view="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.5, delay: 0.15 }"
          :in-view-options="{ once: true }"
        >
          <div class="space-y-4">
            <div
              v-for="benefit in benefits"
              :key="benefit.title"
              class="flex items-start gap-3"
            >
              <UIcon :name="benefit.icon" class="size-4 mt-0.5 shrink-0 text-emerald-500" />
              <div>
                <p class="font-mono text-xs text-highlighted">
                  {{ benefit.title }}
                </p>
                <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
                  {{ benefit.text }}
                </p>
              </div>
            </div>
          </div>
        </Motion>
      </div>

      <Motion
        :initial="false"
        :while-in-view="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, delay: 0.1 }"
        :in-view-options="{ once: true }"
      >
        <div class="overflow-hidden border border-muted bg-default">
          <div class="flex items-center gap-2 border-b border-muted px-4 py-3">
            <div class="flex gap-1.5">
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
              <div class="size-3 rounded-full bg-accented" />
            </div>
            <span class="ml-3 font-mono text-xs text-dimmed">audit.jsonl</span>
            <div class="ml-auto flex items-center gap-1.5">
              <span class="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-500">
                <UIcon name="i-ph-shield-check-duotone" class="size-3" />
                hash-chain
              </span>
            </div>
          </div>

          <div class="px-5 pt-4 pb-3 font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto border-b border-muted/50">
            <pre><code>log.<span class="text-amber-400">audit</span>({
  <span class="text-sky-400">action</span>: <span class="text-emerald-400">'invoice.refund'</span>,
  <span class="text-sky-400">actor</span>: { <span class="text-sky-400">type</span>: <span class="text-emerald-400">'user'</span>, <span class="text-sky-400">id</span>: user.id },
  <span class="text-sky-400">target</span>: { <span class="text-sky-400">type</span>: <span class="text-emerald-400">'invoice'</span>, <span class="text-sky-400">id</span>: <span class="text-emerald-400">'inv_889'</span> },
  <span class="text-sky-400">outcome</span>: <span class="text-emerald-400">'success'</span>,
  <span class="text-sky-400">reason</span>: <span class="text-emerald-400">'Customer requested refund'</span>,
})</code></pre>
            <!-- eslint-enable -->
          </div>

          <div class="p-5 font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto">
            <div class="mb-3 flex items-baseline gap-3">
              <span class="font-medium text-emerald-500">INFO</span>
              <span class="text-violet-400">POST</span>
              <span class="text-amber-400">/api/refund</span>
              <span class="ml-auto text-dimmed">(82ms)</span>
            </div>
            <div class="space-y-1 border-l-2 border-emerald-500/30 pl-4">
              <div>
                <span class="text-sky-400">audit.action</span><span class="text-dimmed">:</span>
                <span class="text-emerald-400"> "invoice.refund"</span>
              </div>
              <div>
                <span class="text-sky-400">audit.actor</span><span class="text-dimmed">:</span>
                <span class="text-muted"> &#123; type: "user", id: "u_42" &#125;</span>
              </div>
              <div>
                <span class="text-sky-400">audit.target</span><span class="text-dimmed">:</span>
                <span class="text-muted"> &#123; type: "invoice", id: "inv_889" &#125;</span>
              </div>
              <div>
                <span class="text-sky-400">audit.outcome</span><span class="text-dimmed">:</span>
                <span class="text-emerald-400"> "success"</span>
              </div>
              <div>
                <span class="text-sky-400">audit.context</span><span class="text-dimmed">:</span>
                <span class="text-muted"> &#123; requestId, traceId, ip, userAgent &#125;</span>
              </div>
              <div>
                <span class="text-sky-400">audit.idempotencyKey</span><span class="text-dimmed">:</span>
                <span class="text-pink-400"> "8f2c…"</span>
              </div>
              <div>
                <span class="text-sky-400">audit.prevHash</span><span class="text-dimmed">:</span>
                <span class="text-dimmed"> "a1b2…"</span>
              </div>
              <div>
                <span class="text-sky-400">audit.hash</span><span class="text-dimmed">:</span>
                <span class="text-dimmed"> "c3d4…"</span>
              </div>
            </div>
          </div>
        </div>
      </Motion>
    </div>
  </section>
</template>
