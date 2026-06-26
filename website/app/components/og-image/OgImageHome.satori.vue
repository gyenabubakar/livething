<script setup lang="ts">
defineOptions({ inheritAttrs: false })

defineProps<{
  title?: string
}>()

const brand = '#f4610f'

const surface = {
  backgroundColor: '#09090b',
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)',
  backgroundSize: '48px 48px',
}

// Typed frames riding the one wire — dot colours echo the landing legend.
const frames = [
  { label: 'channel', color: '#f472b6' },
  { label: 'request', color: '#a78bfa' },
  { label: 'stream', color: '#fbbf24' },
]
</script>

<template>
  <div class="flex flex-col size-full" :style="surface">
    <!-- header -->
    <div class="flex flex-row justify-between items-center px-16 pt-12">
      <div class="flex flex-row items-end gap-2">
        <div
          class="flex lowercase font-medium text-[46px] leading-none tracking-tight"
          :style="{ fontFamily: 'Geist Pixel Line', color: '#f5f5f5', textShadow: '0 0 10px rgba(255,255,255,0.3), 0 0 26px rgba(255,255,255,0.12)' }"
        >
          wskit
        </div>
        <div
          class="flex"
          :style="{ width: '8px', height: '8px', marginBottom: '6px', backgroundColor: brand, boxShadow: '0 0 12px rgba(244,97,15,0.55)' }"
        />
      </div>
      <div
        class="flex text-[16px] tracking-[0.18em] font-semibold uppercase"
        :style="{ fontFamily: 'DM Mono', color: '#9ea0a8' }"
      >
        wskit.dev
      </div>
    </div>

    <!-- title -->
    <div class="flex flex-col px-16 pt-11 gap-4">
      <div
        class="flex text-[16px] tracking-[0.24em] font-semibold uppercase"
        :style="{ fontFamily: 'DM Mono', color: '#9598a1' }"
      >
        Typed WebSocket framework
      </div>
      <div
        class="flex max-w-[940px] text-[60px] font-bold leading-[1.05] tracking-[-0.03em]"
        :style="{ fontFamily: 'Geist', color: '#fafafa', textShadow: '0 0 18px rgba(255,255,255,0.08)' }"
      >
        {{ title || 'The complete WebSocket stack for TypeScript' }}
      </div>
    </div>

    <!-- the living wire: client ── typed frames ── server -->
    <div class="flex flex-row items-center flex-1 px-16 gap-5">
      <div
        class="flex flex-col gap-2 shrink-0 border px-5 py-4"
        :style="{ borderColor: 'rgba(56,189,248,0.45)', backgroundColor: 'rgba(56,189,248,0.08)' }"
      >
        <div class="flex flex-row items-center gap-2">
          <div class="flex" :style="{ width: '9px', height: '9px', borderRadius: '9px', backgroundColor: '#38bdf8' }" />
          <div class="flex text-[22px]" :style="{ fontFamily: 'DM Mono', color: '#e5e7eb' }">client</div>
        </div>
        <div class="flex text-[14px]" :style="{ fontFamily: 'DM Mono', color: '#71717a' }">socket.request()</div>
      </div>

      <div class="flex flex-row items-center flex-1" style="position: relative">
        <div
          class="flex"
          :style="{ position: 'absolute', left: '0', right: '0', top: '50%', height: '2px', backgroundColor: 'rgba(244,97,15,0.5)', boxShadow: '0 0 16px rgba(244,97,15,0.45)' }"
        />
        <div class="flex flex-row items-center justify-center gap-4 w-full">
          <div
            v-for="f in frames"
            :key="f.label"
            class="flex flex-row items-center gap-2 border px-4 py-2"
            :style="{ borderColor: 'rgba(255,255,255,0.16)', backgroundColor: '#0c0c0f' }"
          >
            <div class="flex" :style="{ width: '8px', height: '8px', borderRadius: '8px', backgroundColor: f.color }" />
            <div class="flex text-[18px]" :style="{ fontFamily: 'DM Mono', color: '#e5e7eb' }">{{ f.label }}</div>
          </div>
        </div>
      </div>

      <div
        class="flex flex-col gap-2 shrink-0 border px-5 py-4"
        :style="{ borderColor: 'rgba(244,97,15,0.5)', backgroundColor: 'rgba(244,97,15,0.08)' }"
      >
        <div class="flex flex-row items-center gap-2">
          <div class="flex" :style="{ width: '9px', height: '9px', borderRadius: '9px', backgroundColor: brand }" />
          <div class="flex text-[22px]" :style="{ fontFamily: 'DM Mono', color: '#e5e7eb' }">server</div>
        </div>
        <div class="flex text-[14px]" :style="{ fontFamily: 'DM Mono', color: '#71717a' }">base.request()</div>
      </div>
    </div>

    <!-- footer -->
    <div class="flex flex-col px-16 pb-12 pt-2 gap-3">
      <div class="flex w-full h-px" :style="{ backgroundColor: 'rgba(255,255,255,0.1)' }" />
      <div
        class="flex text-[14px] tracking-[0.18em] font-semibold uppercase"
        :style="{ fontFamily: 'DM Mono', color: '#787c85' }"
      >
        channels · streams · requests · reconnection
      </div>
    </div>
  </div>
</template>
