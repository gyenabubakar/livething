import { createScope } from 'animejs'
import type { Scope, Timeline } from 'animejs'
import type { Ref } from 'vue'

/**
 * Builds an anime.js timeline for a landing illustration and plays it only
 * while the illustration is on screen. Under `prefers-reduced-motion` nothing
 * is built, so the SVG keeps its static markup as the final picture.
 */
export function useIllustration(root: Ref<HTMLElement | SVGElement | undefined>, build: () => Timeline) {
  let scope: Scope | undefined
  let timeline: Timeline | undefined
  const reduced = ref(false)

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
      timeline?.play()
    },
    onExit: () => timeline?.pause(),
  })

  onBeforeUnmount(() => scope?.revert())
}
