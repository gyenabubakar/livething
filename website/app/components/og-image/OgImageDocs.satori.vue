<script setup lang="ts">
import { computed } from 'vue'

defineOptions({
  inheritAttrs: false,
})

const brand = '#f4610f'
const brandGlow =
  '0 0 10px rgba(244, 97, 15, 0.38), 0 0 22px rgba(244, 97, 15, 0.16)'

const props = defineProps<{
  title?: string
  description?: string
  headline?: string
}>()

const titleText = computed(() => props.title || 'Documentation')
const titleLen = computed(() => titleText.value.length)

const pixelTitleSize = computed(() => {
  const n = titleLen.value
  if (n <= 14) return '102px'
  if (n <= 20) return '92px'
  if (n <= 28) return '82px'
  if (n <= 36) return '72px'
  if (n <= 46) return '62px'
  if (n <= 58) return '52px'
  return ''
})

const usePixelTitle = computed(() => pixelTitleSize.value !== '')

const titleShadowSoft =
  '0 0 6px rgba(255,255,255,0.2), 0 0 18px rgba(255,255,255,0.1), 0 0 40px rgba(255,255,255,0.04)'
const titleShadowWrapped =
  '0 0 10px rgba(255,255,255,0.28), 0 0 28px rgba(255,255,255,0.12), 0 0 56px rgba(255,255,255,0.05)'

const titleStyle = computed(() => {
  if (usePixelTitle.value) {
    return {
      fontFamily: 'Geist Pixel Line',
      fontWeight: 500,
      fontSize: pixelTitleSize.value,
      lineHeight: 1.06,
      letterSpacing: '-0.02em',
      color: '#fafafa',
      textShadow: titleShadowSoft,
    }
  }
  const n = titleLen.value
  return {
    fontFamily: 'Geist',
    fontWeight: 700,
    fontSize: n > 56 ? '56px' : n > 42 ? '68px' : n > 30 ? '78px' : '88px',
    lineHeight: 1.08,
    letterSpacing: '-0.03em',
    color: '#fafafa',
    textShadow: titleShadowSoft,
  }
})

const titleBloomDuplicate = computed(() => titleLen.value <= 32)

const titleStyleBloom = computed(() => {
  const { textShadow: _textShadow, ...rest } = titleStyle.value
  return {
    ...rest,
    color: 'rgba(255,255,255,0.92)',
  }
})

const titleStyleFront = computed(() => ({
  ...titleStyle.value,
  textShadow:
    '0 0 2px rgba(255,255,255,0.35), 0 0 14px rgba(255,255,255,0.08)',
  position: 'relative' as const,
}))

const titleStyleNoDuplicate = computed(() => ({
  ...titleStyle.value,
  textShadow: titleShadowWrapped,
}))

const periodStyle = computed(() => {
  const key = usePixelTitle.value ? pixelTitleSize.value : titleStyle.value.fontSize
  const px = Number.parseInt(String(key).replace('px', ''), 10) || 72
  const periodPx = Math.max(28, Math.round(px * 0.4))
  const padB = usePixelTitle.value ? Math.round(px * 0.1) : Math.round(px * 0.07)
  return {
    fontFamily: 'Geist',
    fontWeight: 700,
    fontSize: `${periodPx}px`,
    lineHeight: 1,
    color: brand,
    textShadow: brandGlow,
    paddingLeft: '6px',
    paddingBottom: `${padB}px`,
    position: 'relative' as const,
  }
})

const wordmarkGlow = {
  textShadow:
    '0 0 10px rgba(255,255,255,0.32), 0 0 26px rgba(255,255,255,0.12)',
}

const mainColumnStyle = {
  backgroundColor: '#09090b',
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)',
  backgroundSize: '48px 48px',
}

function truncate(str: string, max: number) {
  if (!str || str.length <= max) return str
  return `${str.slice(0, str.lastIndexOf(' ', max))}…`
}
</script>

<template>
  <div
    class="flex flex-row size-full overflow-hidden"
    :style="{ backgroundColor: '#09090b' }"
  >
    <div
      class="flex shrink-0 h-full"
      :style="{
        width: '6px',
        backgroundColor: brand,
        boxShadow: '4px 0 20px rgba(244, 97, 15, 0.28)',
      }"
    />

    <div class="flex flex-col flex-1 min-w-0 min-h-0" :style="mainColumnStyle">
      <div
        aria-hidden="true"
        class="flex font-pixel overflow-hidden font-medium"
        style="width: 0; height: 0; font-size: 1px;"
      >
        og
      </div>
      <div class="flex flex-row justify-between items-center px-14 pt-12 pb-3">
        <div class="flex flex-row items-end gap-2.5">
          <svg width="35" height="48" viewBox="0 0 191 264" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M108.497 234.63C108.497 235.6 107.977 236.496 107.135 236.982L61.3121 263.389C59.8825 264.207 58.1307 264.207 56.701 263.389L2.83675 232.34C1.07932 231.324 0 229.457 0 227.432V59.3515C0 56.6498 2.93281 54.9633 5.27228 56.3113L70.088 93.6558C73.0377 95.3535 73.0377 99.6063 70.088 101.304L50.9428 112.336C49.1401 113.374 48.0325 115.292 48.0325 117.368V200.37C48.0325 201.814 49.5978 202.717 50.8523 201.995L104.417 171.125C106.231 170.082 108.497 171.385 108.497 173.477V234.63Z" fill="url(#og-docs-logo-gradient)" />
            <path d="M82.503 90.5198V29.3733C82.503 28.4032 83.0228 27.5063 83.8648 27.0213L129.688 0.613383C131.118 -0.204461 132.869 -0.204461 134.299 0.613383L188.163 31.6576C189.921 32.6729 191 34.5398 191 36.5647V204.646C191 207.347 188.067 209.034 185.728 207.686L120.912 170.341C117.962 168.644 117.962 164.391 120.912 162.693L140.057 151.661C141.86 150.623 142.967 148.705 142.967 146.63V63.6268C142.967 62.1829 141.402 61.2805 140.148 62.0024L86.5829 92.8718C84.769 93.9153 82.503 92.6124 82.503 90.5198Z" fill="url(#og-docs-logo-gradient)" />
            <defs>
              <linearGradient id="og-docs-logo-gradient" x1="170.5" y1="-0.0014329" x2="36.5" y2="263.999" gradientUnits="userSpaceOnUse">
                <stop stop-color="#FF8025" />
                <stop offset="0.615385" stop-color="#FF6011" />
                <stop offset="1" stop-color="#E14300" />
              </linearGradient>
            </defs>
          </svg>
          <div
            class="flex lowercase font-pixel font-medium text-[40px] leading-none tracking-tight text-[#f5f5f5]"
            :style="wordmarkGlow"
          >
            wskit
          </div>
          <div
            class="flex shrink-0"
            :style="{
              width: '7px',
              height: '7px',
              marginBottom: '5px',
              backgroundColor: brand,
              boxShadow: brandGlow,
            }"
          />
        </div>
        <div
          class="flex text-[15px] tracking-[0.16em] font-semibold uppercase"
          :style="{ fontFamily: 'DM Mono', color: '#9ea0a8' }"
        >
          wskit.dev
        </div>
      </div>

      <div class="flex flex-col flex-1 justify-center px-14 gap-8 min-h-0 pb-8">
        <div
          v-if="headline"
          class="flex text-[16px] tracking-[0.24em] font-semibold uppercase"
          :style="{ fontFamily: 'DM Mono', color: '#9598a1' }"
        >
          {{ headline.toUpperCase() }}
        </div>

        <div class="flex flex-row flex-wrap items-end gap-0 max-w-[1080px]">
          <div
            v-if="titleBloomDuplicate"
            class="flex flex-row items-end"
            style="position: relative;"
          >
            <div
              aria-hidden="true"
              class="flex"
              :style="{
                ...titleStyleBloom,
                position: 'absolute',
                left: '0',
                top: '0',
                filter: 'blur(11px)',
                opacity: 0.42,
                whiteSpace: 'nowrap',
              }"
            >
              {{ titleText }}
            </div>
            <div class="flex" :style="titleStyleFront">
              {{ titleText }}
            </div>
          </div>
          <div
            v-else
            class="flex max-w-[1000px]"
            :style="titleStyleNoDuplicate"
          >
            {{ titleText }}
          </div>
          <div class="flex shrink-0" :style="periodStyle">
            .
          </div>
        </div>

        <div
          v-if="description"
          class="flex max-w-[640px] text-[28px] font-normal"
          :style="{
            fontFamily: 'Geist',
            lineHeight: 1.55,
            color: '#babdc6',
          }"
        >
          {{ truncate(description, 140) }}
        </div>
      </div>

      <div class="flex flex-col px-14 pb-11 pt-2 gap-3 shrink-0">
        <div class="flex flex-row items-center w-full gap-0">
          <div class="flex shrink-0" :style="{ width: '7px', height: '7px', backgroundColor: brand, boxShadow: brandGlow }" />
          <div class="flex flex-1" :style="{ height: '1px', backgroundColor: 'rgba(244,97,15,0.25)' }" />
          <div class="flex shrink-0" :style="{ width: '7px', height: '7px', backgroundColor: brand, boxShadow: brandGlow }" />
        </div>
        <div class="flex flex-row justify-between items-center gap-8">
          <div
            class="flex text-[13px] tracking-[0.18em] font-semibold uppercase"
            :style="{ fontFamily: 'DM Mono', color: '#787c85' }"
          >
            CHANNELS · STREAMS · REQUESTS · TYPESCRIPT
          </div>
          <div
            v-if="headline"
            class="flex text-[13px] tracking-[0.16em] font-semibold uppercase shrink-0"
            :style="{ fontFamily: 'DM Mono', color: '#787c85' }"
          >
            {{ headline.toUpperCase() }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
