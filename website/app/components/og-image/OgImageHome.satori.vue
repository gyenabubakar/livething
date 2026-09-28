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
      <div class="flex flex-row items-end gap-3">
        <svg width="39" height="54" viewBox="0 0 191 264" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M108.497 234.63C108.497 235.6 107.977 236.496 107.135 236.982L61.3121 263.389C59.8825 264.207 58.1307 264.207 56.701 263.389L2.83675 232.34C1.07932 231.324 0 229.457 0 227.432V59.3515C0 56.6498 2.93281 54.9633 5.27228 56.3113L70.088 93.6558C73.0377 95.3535 73.0377 99.6063 70.088 101.304L50.9428 112.336C49.1401 113.374 48.0325 115.292 48.0325 117.368V200.37C48.0325 201.814 49.5978 202.717 50.8523 201.995L104.417 171.125C106.231 170.082 108.497 171.385 108.497 173.477V234.63Z" fill="url(#og-home-logo-gradient)" />
          <path d="M82.503 90.5198V29.3733C82.503 28.4032 83.0228 27.5063 83.8648 27.0213L129.688 0.613383C131.118 -0.204461 132.869 -0.204461 134.299 0.613383L188.163 31.6576C189.921 32.6729 191 34.5398 191 36.5647V204.646C191 207.347 188.067 209.034 185.728 207.686L120.912 170.341C117.962 168.644 117.962 164.391 120.912 162.693L140.057 151.661C141.86 150.623 142.967 148.705 142.967 146.63V63.6268C142.967 62.1829 141.402 61.2805 140.148 62.0024L86.5829 92.8718C84.769 93.9153 82.503 92.6124 82.503 90.5198Z" fill="url(#og-home-logo-gradient)" />
          <defs>
            <linearGradient id="og-home-logo-gradient" x1="170.5" y1="-0.0014329" x2="36.5" y2="263.999" gradientUnits="userSpaceOnUse">
              <stop stop-color="#FF8025" />
              <stop offset="0.615385" stop-color="#FF6011" />
              <stop offset="1" stop-color="#E14300" />
            </linearGradient>
          </defs>
        </svg>
        <div
          class="flex font-semibold text-[46px] leading-none tracking-tight"
          :style="{ fontFamily: 'Geist', color: '#f5f5f5', textShadow: '0 0 10px rgba(255,255,255,0.3), 0 0 26px rgba(255,255,255,0.12)' }"
        >
          LiveThing
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
        livething.dev
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
