import { createScope } from 'animejs'
import type { Scope, Timeline } from 'animejs'
import type { Ref } from 'vue'

/**
 * Builds an anime.js timeline for a landing illustration and plays it only
 * while the illustration is on screen. Under `prefers-reduced-motion` nothing
 * is built, so the SVG keeps its static markup as the final picture. A
 * `paused` ref, when given, holds the timeline still while it is true.
 */
export function useIllustration(
  root: Ref<HTMLElement | SVGElement | undefined>,
  build: () => Timeline,
  options: { paused?: Ref<boolean> } = {},
) {
  let scope: Scope | undefined
  let timeline: Timeline | undefined
  let visible = false
  const reduced = ref(false)

  const sync = () => {
    if (visible && !options.paused?.value) timeline?.play()
    else timeline?.pause()
  }

  onMounted(() => {
    reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useViewportActivation(root as Ref<HTMLElement | undefined>, {
    threshold: 0.25,
    disabled: reduced,
    onEnter() {
      if (!timeline) {
        scope = createScope({ root: root.value as HTMLElement }).add(() => {
          timeline = build()
        })
      }
      visible = true
      sync()
    },
    onExit() {
      visible = false
      sync()
    },
  })

  if (options.paused) watch(options.paused, sync)

  onBeforeUnmount(() => scope?.revert())
}
