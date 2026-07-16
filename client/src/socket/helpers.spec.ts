import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { idGenerator } from '~/internal/id.ts';
import { signalBus } from '~/internal/signals.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WSKitSocket } from '~/socket/socket.ts';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

/** Build a socket and return its helpers object directly. */
function makeHelpers() {
  const socket = client()(connect('wss://test'));
  return (socket as WSKitSocket)._helpers();
}

describe('signal bus', () => {
  it('every primitive on one socket reaches the same bus through the shared registry', () => {
    const helpers = makeHelpers();
    expect(signalBus(helpers)).toBe(signalBus(helpers));
  });

  it('unsubscribing stops the handler from receiving later signals', () => {
    const bus = signalBus(makeHelpers());
    const received: boolean[] = [];
    const unsub = bus.on('online', (v) => received.push(v));

    bus.emit('online', true);
    expect(received).toEqual([true]);

    unsub();

    bus.emit('online', false);
    expect(received).toHaveLength(1);
  });

  it('emit to a name with no listeners is a safe no-op', () => {
    const bus = signalBus(makeHelpers());
    expect(() => bus.emit('online', true)).not.toThrow();
  });

  it('emit to a name after every subscriber has unsubscribed is a safe no-op', () => {
    const bus = signalBus(makeHelpers());
    const unsub = bus.on('online', () => {});
    unsub();
    expect(() => bus.emit('online', true)).not.toThrow();
  });

  it('other handlers for the same signal still fire after one is unsubscribed', () => {
    const bus = signalBus(makeHelpers());
    const a: boolean[] = [];
    const b: boolean[] = [];
    const unsubA = bus.on('online', (v) => a.push(v));
    bus.on('online', (v) => b.push(v));

    bus.emit('online', true);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);

    unsubA();
    bus.emit('online', false);
    expect(a).toHaveLength(1);
    expect(b).toEqual([true, false]);
  });
});

describe('generateId', () => {
  // Ids carry a per-socket random scope segment before the counter so two fresh
  // sockets never collide (#1): `<scope>-<n>` with no prefix, `<prefix>-<scope>-<n>` with one.
  it('returns scope-counter when no prefix is given', () => {
    const gen = idGenerator(makeHelpers());
    const id = gen();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^.+-\d+$/);
  });

  it('returns prefix-scope-N when a prefix is given', () => {
    const gen = idGenerator(makeHelpers());
    const id = gen('ack');
    expect(id).toMatch(/^ack-.+-\d+$/);
  });

  it('every primitive on one socket shares the same generator', () => {
    const helpers = makeHelpers();
    expect(idGenerator(helpers)).toBe(idGenerator(helpers));
  });

  it('successive calls produce strictly increasing counters', () => {
    const gen = idGenerator(makeHelpers());
    function counter(id: string): number {
      return Number(id.split('-').at(-1));
    }
    const first = counter(gen());
    const second = counter(gen());
    const third = counter(gen());
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('ids are unique across successive calls regardless of prefix', () => {
    const gen = idGenerator(makeHelpers());
    const ids = [gen('ack'), gen('req'), gen('ack'), gen()];
    const underlying = ids.map((id: string) => id.split('-').at(-1));
    const unique = new Set(underlying);
    expect(unique.size).toBe(ids.length);
  });

  it('a stream id and a request id on the same socket never share the same underlying counter value', () => {
    const gen = idGenerator(makeHelpers());
    const streamId = gen('stream');
    const reqId = gen('req');
    const streamN = streamId.replace('stream-', '');
    const reqN = reqId.replace('req-', '');
    expect(streamN).not.toBe(reqN);
  });
});

describe('id scope fallback (#17)', () => {
  /** The per-socket scope segment of `<scope>-<n>` (no prefix). */
  function scopeOf(socket: WSKitSocket): string {
    const id = idGenerator(socket._helpers())();
    return id.slice(0, id.lastIndexOf('-'));
  }

  let originalCrypto: Crypto;
  beforeEach(() => {
    originalCrypto = globalThis.crypto;
  });
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    vi.restoreAllMocks();
  });

  function setCrypto(value: unknown): void {
    Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
  }

  it('two fresh sockets get different scopes', () => {
    const a = client()(connect('wss://test')) as WSKitSocket;
    const b = client()(connect('wss://test')) as WSKitSocket;
    expect(scopeOf(a)).not.toBe(scopeOf(b));
  });

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    let counter = 0;
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (counter + i) % 256;
        counter += 7;
        return array;
      },
    });
    const a = client()(connect('wss://test')) as WSKitSocket;
    const b = client()(connect('wss://test')) as WSKitSocket;
    expect(scopeOf(a)).not.toBe(scopeOf(b));
    expect(scopeOf(a)).toMatch(/^[0-9a-f]{32}/);
  });

  it('a frozen weak RNG cannot make two sockets collide because the scope uses getRandomValues', () => {
    // Math.random pinned to a constant — if the scope relied on it, two sockets
    // would collide. getRandomValues still varies, so they must not.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let nonce = 100;
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (nonce * (i + 1)) % 256;
        nonce += 13;
        return array;
      },
    });
    const a = client()(connect('wss://test')) as WSKitSocket;
    const b = client()(connect('wss://test')) as WSKitSocket;
    expect(scopeOf(a)).not.toBe(scopeOf(b));
  });
});
