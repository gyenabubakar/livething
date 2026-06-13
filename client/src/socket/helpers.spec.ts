import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
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

describe('onSignal / emitSignal', () => {
  it('unsubscribing stops the handler from receiving later signals', () => {
    const helpers = makeHelpers();
    const received: boolean[] = [];
    const unsub = helpers.onSignal('online', (v: boolean) => received.push(v));

    helpers.emitSignal('online', true);
    expect(received).toEqual([true]);

    unsub();

    helpers.emitSignal('online', false);
    expect(received).toHaveLength(1); // handler did not fire again
  });

  it('emitSignal to a name with no listeners is a safe no-op', () => {
    const helpers = makeHelpers();
    expect(() => helpers.emitSignal('online', true)).not.toThrow();
  });

  it('emitSignal to a name after every subscriber has unsubscribed is a safe no-op', () => {
    const helpers = makeHelpers();
    const unsub = helpers.onSignal('online', () => {});
    unsub();
    expect(() => helpers.emitSignal('online', true)).not.toThrow();
  });

  it('other handlers for the same signal still fire after one is unsubscribed', () => {
    const helpers = makeHelpers();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const unsubA = helpers.onSignal('online', (v: boolean) => a.push(v));
    helpers.onSignal('online', (v: boolean) => b.push(v));

    helpers.emitSignal('online', true);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);

    unsubA();
    helpers.emitSignal('online', false);
    expect(a).toHaveLength(1); // A stopped
    expect(b).toEqual([true, false]); // B continued
  });
});

describe('generateId', () => {
  // Ids carry a per-socket random scope segment before the counter so two fresh
  // sockets never collide (#1): `<scope>-<n>` with no prefix, `<prefix>-<scope>-<n>` with one.
  it('returns scope-counter when no prefix is given', () => {
    const helpers = makeHelpers();
    const id = helpers.generateId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^.+-\d+$/);
  });

  it('returns prefix-scope-N when a prefix is given', () => {
    const helpers = makeHelpers();
    const id = helpers.generateId('ack');
    expect(id).toMatch(/^ack-.+-\d+$/);
  });

  it('successive calls produce strictly increasing counters', () => {
    const helpers = makeHelpers();
    function counter(id: string): number {
      return Number(id.split('-').at(-1));
    }
    const first = counter(helpers.generateId());
    const second = counter(helpers.generateId());
    const third = counter(helpers.generateId());
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('ids are unique across successive calls regardless of prefix', () => {
    const helpers = makeHelpers();
    const ids = [
      helpers.generateId('ack'),
      helpers.generateId('req'),
      helpers.generateId('ack'),
      helpers.generateId(),
    ];
    const underlying = ids.map((id: string) => id.split('-').at(-1));
    const unique = new Set(underlying);
    expect(unique.size).toBe(ids.length);
  });

  it('an ack id and a request id on the same socket never share the same underlying counter value', () => {
    const helpers = makeHelpers();
    const ackId = helpers.generateId('ack');
    const reqId = helpers.generateId('req');
    const ackN = ackId.replace('ack-', '');
    const reqN = reqId.replace('req-', '');
    expect(ackN).not.toBe(reqN);
  });
});

describe('id scope fallback (#17)', () => {
  /** The per-socket scope segment of `<scope>-<n>` (no prefix). */
  function scopeOf(socket: WSKitSocket): string {
    const id = socket._helpers().generateId();
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
      // No randomUUID — force the getRandomValues path.
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) array[i] = (counter + i) % 256;
        counter += 7;
        return array;
      },
    });
    const a = client()(connect('wss://test')) as WSKitSocket;
    const b = client()(connect('wss://test')) as WSKitSocket;
    // Distinct secure-random bytes per socket → distinct scopes, with no dependence
    // on Math.random.
    expect(scopeOf(a)).not.toBe(scopeOf(b));
    expect(scopeOf(a)).toMatch(/^[0-9a-f]{32}/); // 16 bytes hex
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
