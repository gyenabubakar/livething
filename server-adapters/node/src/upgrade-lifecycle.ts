import type { IncomingMessage } from 'node:http';

interface NodeUpgradeAbort {
  readonly signal: AbortSignal;
  abort(): void;
  dispose(): void;
}

/** Tracks upgrade work that must finish before a host binding shuts down. */
export interface UpgradeLifecycle {
  prepare<T>(
    request: IncomingMessage,
    prepare: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined>;
  shutdown(shutdown: () => Promise<void>): Promise<void>;
}

/** Creates the cancellation and shutdown lifecycle shared by Node host bindings. */
export function createUpgradeLifecycle(): UpgradeLifecycle {
  const pending = new Set<Promise<unknown>>();
  const aborts = new Set<NodeUpgradeAbort>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    prepare<T>(
      request: IncomingMessage,
      prepare: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | undefined> {
      if (shuttingDown) return Promise.resolve(undefined);

      const abort = createNodeUpgradeAbort(request);
      aborts.add(abort);

      let task: Promise<T>;
      try {
        task = prepare(abort.signal);
      } catch (error) {
        task = Promise.reject(error);
      }

      const result = task.then((value) => (abort.signal.aborted ? undefined : value));
      pending.add(result);
      void result.then(cleanup, cleanup);

      function cleanup(): void {
        pending.delete(result);
        aborts.delete(abort);
        abort.dispose();
      }

      return result;
    },

    shutdown(shutdown) {
      if (!shutdownPromise) {
        shuttingDown = true;
        for (const abort of aborts) abort.abort();
        shutdownPromise = Promise.allSettled([...pending]).then(() => shutdown());
      }

      return shutdownPromise;
    },
  };
}

export function createNodeUpgradeAbort(request: IncomingMessage): NodeUpgradeAbort {
  const controller = new AbortController();
  const socket = request.socket;
  function abort(): void {
    controller.abort();
  }

  request.once('aborted', abort);
  socket.once('close', abort);
  socket.once('end', abort);
  socket.once('error', abort);

  return {
    signal: controller.signal,
    abort,
    dispose() {
      request.off('aborted', abort);
      socket.off('close', abort);
      socket.off('end', abort);
      socket.off('error', abort);
    },
  };
}
