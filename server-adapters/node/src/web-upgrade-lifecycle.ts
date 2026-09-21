/** Tracks Fetch-based upgrade work that must finish before a host binding shuts down. */
export interface WebUpgradeLifecycle {
  prepare<T>(
    prepare: (signal: AbortSignal) => Promise<T>,
    sourceSignal?: AbortSignal,
  ): Promise<T | undefined>;
  shutdown(shutdown: () => Promise<void>): Promise<void>;
}

/** Creates cancellation and shutdown handling for Fetch-based WebSocket upgrades. */
export function createWebUpgradeLifecycle(): WebUpgradeLifecycle {
  const pending = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    prepare<T>(
      prepare: (signal: AbortSignal) => Promise<T>,
      sourceSignal?: AbortSignal,
    ): Promise<T | undefined> {
      if (shuttingDown) return Promise.resolve(undefined);

      const controller = new AbortController();
      function abort(): void {
        controller.abort();
      }

      sourceSignal?.addEventListener('abort', abort, { once: true });
      if (sourceSignal?.aborted) controller.abort();
      controllers.add(controller);

      let resolveResult!: (value: T | undefined) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<T | undefined>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      pending.add(result);
      void result.then(cleanup, cleanup);

      try {
        Promise.resolve(prepare(controller.signal)).then(
          (value) => resolveResult(controller.signal.aborted ? undefined : value),
          rejectResult,
        );
      } catch (error) {
        rejectResult(error);
      }

      function cleanup(): void {
        pending.delete(result);
        controllers.delete(controller);
        sourceSignal?.removeEventListener('abort', abort);
      }

      return result;
    },

    shutdown(shutdown) {
      if (!shutdownPromise) {
        shuttingDown = true;
        for (const controller of controllers) controller.abort();
        shutdownPromise = Promise.allSettled([...pending]).then(() => shutdown());
      }

      return shutdownPromise;
    },
  };
}
