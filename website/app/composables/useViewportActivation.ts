import type { MaybeRefOrGetter, Ref } from 'vue'

/**
 * Runs an element's animation only while it is on screen.
 *
 * Wires a single `IntersectionObserver` to a template ref: `onEnter` fires each
 * time the element scrolls into view and `onExit` each time it leaves, so a
 * looping demo can start on first sight, pause when scrolled past, and resume
 * when it comes back. Unlike a fire-once observer, this keeps observing for the
 * lifetime of the component and disconnects on unmount.
 *
 * When `disabled` is true (for example under `prefers-reduced-motion`) the
 * element is never observed and never activated — the caller is expected to
 * paint its final state directly.
 */
export interface ViewportActivationOptions {
  /** Fraction of the element that must be visible before it counts as on screen. */
  threshold?: number
  /** Invoked every time the element scrolls into view. */
  onEnter: () => void
  /** Invoked every time the element scrolls out of view. */
  onExit?: () => void
  /** When true, skip observing entirely and leave the element inactive. */
  disabled?: MaybeRefOrGetter<boolean>
}

export function useViewportActivation(
  target: Ref<HTMLElement | undefined>,
  options: ViewportActivationOptions,
): void {
  let observer: IntersectionObserver | undefined

  onMounted(() => {
    if (toValue(options.disabled)) return

    const element = target.value
    const observerIsSupported = typeof IntersectionObserver !== 'undefined'

    if (!element || !observerIsSupported) {
      options.onEnter()
      return
    }

    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return

        if (entry.isIntersecting) options.onEnter()
        else options.onExit?.()
      },
      { threshold: options.threshold ?? 0 },
    )
    observer.observe(element)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = undefined
  })
}
