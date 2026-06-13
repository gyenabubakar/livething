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
      // A real unsubscribe stops routing — so a test that emits after an unbind
      // sees nothing, making listener-lifecycle assertions mutation-sensitive.
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

    // Hide the app — timer fires and platform calls disconnect() with selfDisconnecting=true.
    m.setVisible(false);
    vi.advanceTimersByTime(500);
    expect(socket.getState()).toBe('closed');

    // The background drop should NOT have unsubscribed the network listener.
    expect(m.netUnsub).not.toHaveBeenCalled();
  });

  it('detaches the network listener only on a genuine user disconnect()', () => {
    const m = mockEnvironment();
    const { socket } = build(platform({ environment: m.environment, backgroundDisconnectMs: 500 }));

    expect(m.netUnsub).not.toHaveBeenCalled();

    socket.disconnect();

    // A real user disconnect must unbind both environment listeners.
    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });

  it('network listener stays live after a background disconnect and still routes signals after reopen', () => {
    const m = mockEnvironment();
    const { capture, received } = (() => {
      const r = makeSignalCapture('online');
      return { capture: r.primitive, received: r.received };
    })();
    build(platform({ environment: m.environment, backgroundDisconnectMs: 500 }), capture);

    // Drive a background disconnect.
    m.setVisible(false);
    vi.advanceTimersByTime(500);

    // Foreground triggers reconnect.
    m.setVisible(true);
    MockWebSocket.last().open();

    // Trigger the network listener post-reopen — it must still be alive and
    // route the signal to any subscriber.
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
    // Cancel the timer by coming back before 2000ms.
    vi.advanceTimersByTime(500);
    m.setVisible(true);
    // Go hidden again.
    m.setVisible(false);

    expect(received).toEqual([false, true, false]);
  });

  it('emits the visibility signal even when backgroundDisconnectMs is not set', () => {
    const m = mockEnvironment();
    const { primitive, received } = makeSignalCapture();
    const { socket } = build(platform({ environment: m.environment }), primitive); // no background disconnect

    m.setVisible(false);
    m.setVisible(true);

    // The signal is a general extension point — it fires regardless.
    expect(received).toEqual([false, true]);

    // And without backgroundDisconnectMs, going hidden must NOT drop the socket.
    m.setVisible(false);
    vi.advanceTimersByTime(60_000);
    expect(socket.getState()).toBe('open');
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
    // Registration order = primitive order: thrower runs before `second`.
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
    // Network cleanup is registered first; make it throw and verify the later
    // visibility cleanup still runs.
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

    socket.disconnect(); // close → unbind runs every cleanup

    expect(visUnsub).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
