import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { platform } from '~/primitives/platform.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmptyTypeFn, Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { message: { text: string } };
}

function mockEnvironment() {
  let vis: ((v: boolean) => void) | null = null;
  let net: ((v: boolean) => void) | null = null;
  const visUnsub = vi.fn();
  const netUnsub = vi.fn();
  const instance = environment({
    onVisibilityChange(cb) {
      vis = cb;
      return () => {
        vis = null;
        visUnsub();
      };
    },
    onNetworkChange(cb) {
      net = cb;
      return () => {
        net = null;
        netUnsub();
      };
    },
  });
  return {
    environment: instance,
    visUnsub,
    netUnsub,
    setVisible: (v: boolean) => vis?.(v),
    setOnline: (v: boolean) => net?.(v),
  };
}

/**
 * A primitive that captures every signal of the given name emitted on the shared bus.
 * Registers its onSignal listener at setup time (before the socket opens).
 */
function makeSignalCapture(signal: 'visibility' | 'online' = 'visibility'): {
  primitive: Primitive<EmptyTypeFn>;
  received: boolean[];
} {
  const received: boolean[] = [];
  const primitive: Primitive<EmptyTypeFn> = {
    _tag: 'signal-capture',
    setup(helpers) {
      helpers.onSignal(signal, (value) => received.push(value));
      return { id: 'signal-capture' };
    },
  };
  return { primitive, received };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

describe('network-change listener lifecycle via selfDisconnecting flag', () => {
  it('keeps the network listener alive after a background (self) disconnect', () => {
    const m = mockEnvironment();
    const { socket } = build(platform({ environment: m.environment, backgroundDisconnectMs: 500 }));

    m.setVisible(false);
    vi.advanceTimersByTime(500);
    expect(socket.state.get()).toBe('closed');

    expect(m.netUnsub).not.toHaveBeenCalled();
  });

  it('detaches the network listener only on a genuine user disconnect()', () => {
    const m = mockEnvironment();
    const { socket } = build(platform({ environment: m.environment, backgroundDisconnectMs: 500 }));

    expect(m.netUnsub).not.toHaveBeenCalled();

    socket.disconnect();

    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });

  it('network listener stays live after a background disconnect and still routes signals after reopen', () => {
    const m = mockEnvironment();
    const { capture, received } = (() => {
      const r = makeSignalCapture('online');
      return { capture: r.primitive, received: r.received };
    })();
    build(platform({ environment: m.environment, backgroundDisconnectMs: 500 }), capture);

    m.setVisible(false);
    vi.advanceTimersByTime(500);

    m.setVisible(true);
    MockWebSocket.last().open();

    m.setOnline(false);
    expect(received).toEqual([false]);

    m.setOnline(true);
    expect(received).toEqual([false, true]);
  });
});

describe('visibility signal routing via onSignal', () => {
  it('emits a visibility signal with value=false when the app is hidden', () => {
    const m = mockEnvironment();
    const { primitive, received } = makeSignalCapture();
    build(platform({ environment: m.environment, backgroundDisconnectMs: 1000 }), primitive);

    m.setVisible(false);

    expect(received).toEqual([false]);
  });

  it('emits a visibility signal with value=true when the app becomes visible again', () => {
    const m = mockEnvironment();
    const { primitive, received } = makeSignalCapture();
    build(platform({ environment: m.environment, backgroundDisconnectMs: 1000 }), primitive);

    m.setVisible(false);
    m.setVisible(true);

    expect(received).toEqual([false, true]);
  });

  it('emits a signal on every flip, not just the first', () => {
    const m = mockEnvironment();
    const { primitive, received } = makeSignalCapture();
    build(platform({ environment: m.environment, backgroundDisconnectMs: 2000 }), primitive);

    m.setVisible(false);
    vi.advanceTimersByTime(500);
    m.setVisible(true);
    m.setVisible(false);

    expect(received).toEqual([false, true, false]);
  });

  it('emits the visibility signal even when backgroundDisconnectMs is not set', () => {
    const m = mockEnvironment();
    const { primitive, received } = makeSignalCapture();
    const { socket } = build(platform({ environment: m.environment }), primitive);

    m.setVisible(false);
    m.setVisible(true);

    expect(received).toEqual([false, true]);

    // And without backgroundDisconnectMs, going hidden must NOT drop the socket.
    m.setVisible(false);
    vi.advanceTimersByTime(60_000);
    expect(socket.state.get()).toBe('open');
  });
});

describe('signal handler isolation (#20)', () => {
  it('a throwing signal handler does not block later handlers and is reported', () => {
    const m = mockEnvironment();
    const errors: unknown[] = [];
    const second = makeSignalCapture('online');
    const thrower: Primitive<EmptyTypeFn> = {
      _tag: 'signal-thrower',
      setup(helpers) {
        helpers.onSignal('online', () => {
          throw new Error('signal boom');
        });
        return { id: 'signal-thrower' };
      },
    };
    const { socket } = build(
      platform({ environment: m.environment, backgroundDisconnectMs: 500 }),
      thrower,
      second.primitive,
    );
    socket.onError((error) => errors.push(error));

    m.setOnline(true);

    expect(second.received.length).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('environment cleanup isolation (#21)', () => {
  it('one throwing cleanup still detaches the other listeners', () => {
    const visUnsub = vi.fn();
    const env = environment({
      onNetworkChange() {
        return () => {
          throw new Error('cleanup boom');
        };
      },
      onVisibilityChange() {
        return visUnsub;
      },
    });
    const errors: unknown[] = [];
    const { socket } = build(platform({ environment: env, backgroundDisconnectMs: 500 }));
    socket.onError((error) => errors.push(error));

    socket.disconnect();

    expect(visUnsub).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
