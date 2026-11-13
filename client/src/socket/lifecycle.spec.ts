import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectDescriptor } from '~/connect.ts';
import type { PrimitiveHelpers, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: Record<string, unknown>;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function c<const P extends readonly Primitive<any, any>[]>(
  connectDescriptor: ConnectDescriptor,
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  return client<C>()(connectDescriptor, ...primitives);
}

function makePrimitive(
  id: string,
  options: { throwOnClose?: boolean } = {},
): {
  primitive: Primitive;
  closeLog: Array<{ code: number; reason: string; intentional: boolean }>;
} {
  const closeLog: Array<{ code: number; reason: string; intentional: boolean }> = [];
  const primitive: Primitive = {
    _tag: `test-${id}`,
    setup(_helpers: PrimitiveHelpers): PrimitiveRuntime {
      return {
        id,
        onClose({ code, reason, intentional }) {
          if (options.throwOnClose) {
            throw new Error(`${id} onClose threw`);
          }

          closeLog.push({ code, reason, intentional });
        },
      };
    },
  };

  return { primitive, closeLog };
}

describe('primitive onClose throw isolation on serverClose', () => {
  it('sibling primitives still get onClose called when an earlier primitive throws', () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });
    const { primitive: siblingPrimitive, closeLog } = makePrimitive('sibling');

    const socket = c(connect('wss://test'), throwingPrimitive, siblingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006, 'drop');

    expect(closeLog).toHaveLength(1);
    expect(closeLog[0]).toMatchObject({ code: 1006, reason: 'drop', intentional: false });
  });

  it('state settles to closed even when a primitive onClose throws (no reconnection)', () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });

    const socket = c(connect('wss://test'), throwingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);

    expect(socket.state.get()).toBe('closed');
  });

  it('state settles to reconnecting even when a primitive onClose throws (with reconnection)', () => {
    vi.useFakeTimers();
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });

    const socket = c(connect('wss://test'), throwingPrimitive, reconnection());
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);

    expect(socket.state.get()).toBe('reconnecting');
  });

  it("user 'close' event fires even when a primitive onClose throws", () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });
    const onClose = vi.fn();

    const socket = c(connect('wss://test'), throwingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    socket.onClose(onClose);

    MockWebSocket.last().serverClose(1006, 'drop');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: 'drop', wasClean: false });
  });
});

describe('primitive onClose throw isolation on disconnect()', () => {
  it('later primitives still get onClose called when an earlier primitive throws during disconnect', () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });
    const { primitive: siblingPrimitive, closeLog } = makePrimitive('sibling');

    const socket = c(connect('wss://test'), throwingPrimitive, siblingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    socket.disconnect();

    expect(closeLog).toHaveLength(1);
    expect(closeLog[0]).toMatchObject({ intentional: true });
  });

  it("user 'close' event fires exactly once when a primitive throws during disconnect", () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });
    const onClose = vi.fn();

    const socket = c(connect('wss://test'), throwingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    socket.onClose(onClose);

    socket.disconnect(1000, 'bye');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'bye', wasClean: true });
  });

  it('state is closed after disconnect even when a primitive throws', () => {
    const { primitive: throwingPrimitive } = makePrimitive('thrower', { throwOnClose: true });

    const socket = c(connect('wss://test'), throwingPrimitive);
    socket.onError(() => {});
    socket.connect();
    MockWebSocket.last().open();
    socket.disconnect();

    expect(socket.state.get()).toBe('closed');
  });
});

describe('_setState no-op when entering the same state', () => {
  it('subscribe() callback is not called when the new state equals the current state', () => {
    const socket = c(connect('wss://test'));
    const stateCallback = vi.fn();
    socket.state.subscribe(stateCallback);

    (socket as unknown as { _setState: (s: string) => void })._setState('closed');

    expect(stateCallback).not.toHaveBeenCalled();
  });

  it('subscribe() is called exactly once for a real state change', () => {
    const socket = c(connect('wss://test'));
    const stateCallback = vi.fn();
    socket.state.subscribe(stateCallback);

    socket.connect();

    expect(stateCallback).toHaveBeenCalledTimes(1);
  });
});

describe('event ordering on reconnect open', () => {
  it('onOpen fires before onReconnect on a reconnect', () => {
    vi.useFakeTimers();
    const socket = c(connect('wss://test'), reconnection());
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);

    const order: string[] = [];
    socket.onOpen(() => order.push('open'));
    socket.onReconnect(() => order.push('reconnect'));

    vi.advanceTimersByTime(2000);
    MockWebSocket.last().open();

    expect(order).toEqual(['open', 'reconnect']);
  });

  it('onOpen and onReconnect each fire exactly once on a single reconnect open', () => {
    vi.useFakeTimers();
    const socket = c(connect('wss://test'), reconnection());
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);

    const onOpen = vi.fn();
    const onReconnect = vi.fn();
    socket.onOpen(onOpen);
    socket.onReconnect(onReconnect);

    vi.advanceTimersByTime(2000);
    MockWebSocket.last().open();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('onReconnect does not fire on the first open', () => {
    const socket = c(connect('wss://test'));
    const onReconnect = vi.fn();
    socket.onReconnect(onReconnect);

    socket.connect();
    MockWebSocket.last().open();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('state is open by the time onOpen fires', () => {
    const socket = c(connect('wss://test'));
    let stateAtOpen = '';
    socket.onOpen(() => {
      stateAtOpen = socket.state.get();
    });
    socket.connect();
    MockWebSocket.last().open();

    expect(stateAtOpen).toBe('open');
  });
});

describe('lazy lazyIdleTimeoutMs:0 never idle-closes', () => {
  it('stays open indefinitely after the last consumer releases when lazyIdleTimeoutMs is 0', () => {
    vi.useFakeTimers();
    const socket = c(connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 0 }));

    const unsub = socket.on('some-event', () => {});
    MockWebSocket.last().open();

    unsub();

    vi.advanceTimersByTime(60_000);

    expect(socket.state.get()).toBe('open');
  });

  it('does not idle-close when the idle timer would be 0 even after multiple release cycles', () => {
    vi.useFakeTimers();
    const socket = c(connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 0 }));

    const unsubA = socket.on('a', () => {});
    const unsubB = socket.on('b', () => {});
    MockWebSocket.last().open();

    unsubA();
    unsubB();

    vi.advanceTimersByTime(30_000);

    expect(socket.state.get()).toBe('open');
  });
});

describe('lazy idle window resets on send', () => {
  it('a send refreshes the idle countdown so send-only usage is not idle-closed', () => {
    vi.useFakeTimers();
    const socket = c(connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 10_000 }));
    const raw = socket as unknown as { send(event: string, payload: unknown): boolean };

    raw.send('echo', {});
    MockWebSocket.last().open();

    vi.advanceTimersByTime(8_000);
    expect(socket.state.get()).toBe('open');

    raw.send('echo', {});
    vi.advanceTimersByTime(8_000);
    expect(socket.state.get()).toBe('open');

    vi.advanceTimersByTime(10_000);
    expect(socket.state.get()).not.toBe('open');
  });
});
