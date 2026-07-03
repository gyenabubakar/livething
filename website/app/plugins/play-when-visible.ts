/**
 * `v-play-when-visible` — pauses a CSS animation while its element is off screen.
 *
 * The decorative glows on the landing (the blurred title echoes and similar)
 * use infinite CSS keyframes, which otherwise run from page load forever, even
 * for sections the reader has scrolled far past. This directive freezes the
 * animation with `animation-play-state: paused` until the element enters the
 * viewport, then lets it run, then freezes it again once it leaves.
 *
 * Under `prefers-reduced-motion` the animation is frozen for good and no
 * observer is created.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const observersByElement = new WeakMap<HTMLElement, IntersectionObserver>()

  nuxtApp.vueApp.directive('play-when-visible', {
    mounted(element: HTMLElement) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (prefersReducedMotion) {
        element.style.animationPlayState = 'paused'
        return
      }

      element.style.animationPlayState = 'paused'

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0]
          if (!entry) return
          element.style.animationPlayState = entry.isIntersecting ? 'running' : 'paused'
        },
        { threshold: 0 },
      )
      observer.observe(element)
      observersByElement.set(element, observer)
    },

    unmounted(element: HTMLElement) {
      observersByElement.get(element)?.disconnect()
      observersByElement.delete(element)
    },
  })
})
