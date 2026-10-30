import { dispatchToHandlers } from '~/internal/dispatch.ts';
import type { PrimitiveHelpers, PrimitiveLogger } from '~/internal/runtime.ts';

/**
 * A signal that one primitive can broadcast and another can listen to, without
 * either importing the other. Only the primitives that opt into the bus ship it,
 * so the socket core stays free of this vocabulary.
 *
 * - `online` — `true` when the device is online, `false` when offline.
 */
type PlatformSignal = 'online';

/** A per-socket pub/sub for {@link PlatformSignal}s. */
export interface SignalBus {
  /** Publish a signal to every current listener. */
  emit(name: PlatformSignal, value: boolean): void;
  /** React to a signal. Returns an unsubscribe. */
  on(name: PlatformSignal, handler: (value: boolean) => void): () => void;
}

const SIGNAL_BUS_KEY = 'signals';

/**
 * The signal bus for a socket, created on first use and cached in the socket's
 * `shared` registry so `platform()` (the emitter) and `reconnection()` (the
 * listener) find the same instance. Because only these primitives call it, the
 * bus is dropped from any socket that uses neither.
 */
export function signalBus(helpers: PrimitiveHelpers): SignalBus {
  const existing = helpers.shared.get(SIGNAL_BUS_KEY) as SignalBus | undefined;
  if (existing) return existing;

  const bus = createSignalBus(helpers.log);
  helpers.shared.set(SIGNAL_BUS_KEY, bus);

  return bus;
}

function createSignalBus(log: PrimitiveLogger): SignalBus {
  const handlers = new Map<PlatformSignal, Set<(value: boolean) => void>>();

  return {
    emit(name, value) {
      const set = handlers.get(name);
      if (set) dispatchToHandlers(set, log, value);
    },

    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler);

      return () => {
        set.delete(handler);
      };
    },
  };
}
