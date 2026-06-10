import { Block } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { ack } from '~/primitives/ack/index.ts';
import { debug } from '~/primitives/debug.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { message: { text: string }; ad: { text: string } };
  outgoing: { typing: { channelId: string } };
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
});
afterEach(() => {
  restore();
});

describe('plugin() definition', () => {
  it('does not require a colon-form id', () => {
    expect(() => plugin({ id: 'nocolon', key: Symbol(), setup: () => () => ({}) })).not.toThrow();
  });

  it('throws when the same singleton plugin is registered twice', () => {
    const KEY = Symbol('acme:once');
    const Once = plugin({ id: 'acme:once', key: KEY, setup: () => () => ({}) });
    expect(() => client<C>()(connect('wss://test'), Once(), Once())).toThrow(
      /registered more than once/,
    );
  });

  it('only warns (does not throw) when two different plugins share an id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const A = plugin({ id: 'acme:dup', key: Symbol(), setup: () => () => ({}) });
    const B = plugin({ id: 'acme:dup', key: Symbol(), setup: () => () => ({}) });
    expect(() => client<C>()(connect('wss://test'), A(), B())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/share the id 'acme:dup'/));
    warn.mockRestore();
  });

  it('allows a repeatable plugin via registrationId and resolves each instance', () => {
    const KEY = Symbol('acme:analytics');
    const Analytics = plugin<{ tracker: string }, { tracker: string }>({
      id: 'acme:analytics',
      key: KEY,
      registrationId: (args) => args.tracker,
      setup: (args) => () => ({ tracker: args.tracker }),
    });
    const socket = client<C>()(
      connect('wss://test'),
      Analytics({ tracker: 'ga' }),
      Analytics({ tracker: 'mixpanel' }),
    );
    expect(Analytics.use(socket, 'ga').tracker).toBe('ga');
    expect(Analytics.use(socket, 'mixpanel').tracker).toBe('mixpanel');
  });

  it('throws when a repeatable plugin reuses a registrationId', () => {
    const KEY = Symbol('acme:analytics');
    const Analytics = plugin<{ tracker: string }>({
      id: 'acme:analytics',
      key: KEY,
      registrationId: (args) => args.tracker,
      setup: () => () => ({}),
    });
    expect(() =>
      client<C>()(
        connect('wss://test'),
        Analytics({ tracker: 'ga' }),
        Analytics({ tracker: 'ga' }),
      ),
    ).toThrow(/same registrationId 'ga'/);
  });

  it('throws when a hook is registered twice', () => {
    const Twice = plugin({
      id: 'test:twice',
      key: Symbol('test:twice'),
      setup(_args, hooks) {
        hooks.onIncoming((m) => m);
        hooks.onIncoming((m) => m);
        return () => ({});
      },
    });
    expect(() => client<C>()(connect('wss://test'), Twice())).toThrow(/onIncoming\(\) twice/);
  });

  it('exposes generateId and getState inside setup hooks', () => {
    const captured: { id?: string; state?: string } = {};
    const Probe = plugin({
      id: 'test:probe',
      key: Symbol('test:probe'),
      setup(_args, hooks) {
        captured.id = hooks.generateId('p');
        captured.state = hooks.getState();
        return () => ({});
      },
    });
    client<C>()(connect('wss://test'), Probe());
    expect(captured.id).toMatch(/^p-\d+$/);
    expect(captured.state).toBe('closed');
  });
});

describe('plugin() dependencies (assertions)', () => {
  const Needs = plugin({
    id: 'test:needs-ack',
    key: Symbol('test:needs-ack'),
    dependencies: [ack],
    setup: () => () => ({}),
  });

  it('throws when a required primitive is missing', () => {
    expect(() => client<C>()(connect('wss://test'), Needs())).toThrow(/requires ack/);
  });

  it('builds when the required primitive is registered', () => {
    expect(() => client<C>()(connect('wss://test'), ack(), Needs())).not.toThrow();
  });
});

describe('plugin() hooks', () => {
  it('onIncoming sees every message; Plugin.use exposes the API', () => {
    const KEY = Symbol('acme:metrics');
    const Metrics = plugin<void, { count(event: string): number }>({
      id: 'acme:metrics',
      key: KEY,
      setup(_args, hooks) {
        const counts = new Map<string, number>();
        hooks.onIncoming((m) => {
          counts.set(m.event, (counts.get(m.event) ?? 0) + 1);
          return m;
        });
        return () => ({ count: (event: string) => counts.get(event) ?? 0 });
      },
    });

    const { socket, ws } = build(Metrics());
    ws.emit({ event: 'message', payload: { text: 'a' } });
    ws.emit({ event: 'message', payload: { text: 'b' } });

    expect(Metrics.use(socket).count('message')).toBe(2);
  });

  it('onIncoming throwing Block drops the message', () => {
    const Filter = plugin({
      id: 'test:filter',
      key: Symbol('test:filter'),
      setup(_args, hooks) {
        hooks.onIncoming((m) => {
          if (m.event === 'ad') throw Block;
          return m;
        });
        return () => ({});
      },
    });

    const { socket, ws } = build(Filter());
    const adHandler = vi.fn();
    const msgHandler = vi.fn();
    socket.on('ad', adHandler);
    socket.on('message', msgHandler);

    ws.emit({ event: 'ad', payload: { text: 'buy' } });
    ws.emit({ event: 'message', payload: { text: 'hi' } });

    expect(adHandler).not.toHaveBeenCalled();
    expect(msgHandler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('onOutgoing can transform a message', () => {
    const Tagger = plugin({
      id: 'test:tagger',
      key: Symbol('test:tagger'),
      setup(_args, hooks) {
        hooks.onOutgoing((m) => ({
          ...m,
          payload: { ...(m.payload as Record<string, unknown>), tagged: true },
        }));
        return () => ({});
      },
    });

    const { socket, ws } = build(Tagger());
    socket.send('typing', { channelId: 'x' });
    expect(ws.sentFrames()[0].payload).toEqual({ channelId: 'x', tagged: true });
  });

  it('onOutgoing throwing Block cancels the send', () => {
    const Canceller = plugin({
      id: 'test:canceller',
      key: Symbol('test:canceller'),
      setup(_args, hooks) {
        hooks.onOutgoing(() => {
          throw Block;
        });
        return () => ({});
      },
    });

    const { socket, ws } = build(Canceller());
    const ok = socket.send('typing', { channelId: 'x' });
    expect(ok).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });

  it('onOpen returns messages that are sent on open', () => {
    const Opener = plugin({
      id: 'test:opener',
      key: Symbol('test:opener'),
      setup(_args, hooks) {
        hooks.onOpen(() => [{ event: 'hello', payload: { n: 1 } }]);
        return () => ({});
      },
    });

    const { ws } = build(Opener());
    expect(ws.sentFrames()).toContainEqual({ event: 'hello', payload: { n: 1 } });
  });

  it('a plugin-authored onReconnect fires on reconnect (not first open) and sends its messages', () => {
    vi.useFakeTimers();
    try {
      const onReconnect = vi.fn(() => [{ event: 'rejoined', payload: { n: 1 } }]);
      const Rejoiner = plugin({
        id: 'test:rejoiner',
        key: Symbol('test:rejoiner'),
        setup(_args, hooks) {
          hooks.onReconnect(onReconnect);
          return () => ({});
        },
      });

      const { ws: first } = build(reconnection(), Rejoiner());
      // The first open is not a reconnect.
      expect(onReconnect).not.toHaveBeenCalled();

      // Drop → the reconnection primitive schedules a retry; the new socket's
      // open is a reconnect, so the plugin's onReconnect must fire.
      first.serverClose(1006, 'drop');
      vi.advanceTimersByTime(1500);
      const second = MockWebSocket.last();
      second.open();

      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(second.sentFrames()).toContainEqual({ event: 'rejoined', payload: { n: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs onIncoming errors only when debug is on', () => {
    const Bad = plugin({
      id: 'test:bad',
      key: Symbol('test:bad'),
      setup(_args, hooks) {
        hooks.onIncoming(() => {
          throw new Error('boom');
        });
        return () => ({});
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const off = build(Bad());
    off.ws.emit({ event: 'message', payload: {} });
    expect(err).not.toHaveBeenCalled(); // debug off → silent

    const on = build(Bad(), debug(true));
    on.ws.emit({ event: 'message', payload: {} });
    expect(err).toHaveBeenCalled(); // debug on → logged

    err.mockRestore();
  });

  it('isolates a throwing lifecycle hook so it does not break the close sequence', () => {
    const Bad = plugin({
      id: 'test:badclose',
      key: Symbol('test:badclose'),
      setup(_args, hooks) {
        hooks.onClose(() => {
          throw new Error('boom');
        });
        return () => ({});
      },
    });
    const { socket } = build(Bad());
    expect(() => socket.disconnect()).not.toThrow();
    expect(socket.getState()).toBe('closed');
  });

  it('onClose fires with the code and reason', () => {
    let closed: [number, string] | null = null;
    const Closer = plugin({
      id: 'test:closer',
      key: Symbol('test:closer'),
      setup(_args, hooks) {
        hooks.onClose((code, reason) => {
          closed = [code, reason];
        });
        return () => ({});
      },
    });

    const { socket } = build(Closer());
    socket.disconnect(4001, 'bye');
    expect(closed).toEqual([4001, 'bye']);
  });
});

describe('ordering', () => {
  it('runs primitive hooks before plugin hooks, regardless of registration order', () => {
    const order: string[] = [];
    const fakePrimitive: Primitive = {
      _tag: 'fake-primitive',
      setup: () => ({
        id: 'fake-primitive',
        onIncoming: (m) => {
          order.push('primitive');
          return m;
        },
      }),
    };
    const P = plugin({
      id: 'test:order',
      key: Symbol('test:order'),
      setup(_args, hooks) {
        hooks.onIncoming((m) => {
          order.push('plugin');
          return m;
        });
        return () => ({});
      },
    });

    // Register the plugin FIRST to prove order is not by position.
    const { ws } = build(P(), fakePrimitive as unknown as Primitive);
    ws.emit({ event: 'message', payload: { text: 'x' } });
    expect(order).toEqual(['primitive', 'plugin']);
  });
});

describe('async hook registration', () => {
  it('[BUG plugin-async-hooks] onIncoming registered after an await inside setup runs when a message arrives', async () => {
    const seen: string[] = [];

    const AsyncHook = plugin({
      id: 'test:async-hook',
      key: Symbol('test:async-hook'),
      setup(_args, hooks) {
        // Register the hook AFTER a microtask (simulates `await someAsyncInit()`)
        Promise.resolve().then(() => {
          hooks.onIncoming((m) => {
            seen.push(m.event);
            return m;
          });
        });
        return () => ({});
      },
    });

    const { ws } = build(AsyncHook());

    // Let the Promise.resolve().then() microtask run so the hook is registered.
    await Promise.resolve();

    ws.emit({ event: 'message', payload: { text: 'hello' } });

    // Correct behavior: the late-registered hook should have seen the message.
    // Today it is silently dropped, so seen stays empty and this assertion fails.
    expect(seen).toEqual(['message']);
  });
});

describe('Plugin.use', () => {
  it('throws when the plugin is not registered on the socket', () => {
    const KEY = Symbol('acme:metrics');
    const Metrics = plugin<void, { ok: boolean }>({
      id: 'acme:metrics',
      key: KEY,
      setup: () => () => ({ ok: true }),
    });
    const other = client<C>()(connect('wss://test'));
    expect(() => Metrics.use(other)).toThrow(/not registered/);
  });
});
