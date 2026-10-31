import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory } from '~/context.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      },
      getStore: () => current,
    };
  };
}

/** A socket that records every frame the engine writes to it. */
function testSocket() {
  const frames: string[] = [];
  return {
    frames,
    descriptor: {
      send: (data: string) => void frames.push(data),
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'tester',
    },
  };
}

/** The slice of a connection context these tests read. */
type HeartbeatCtx = { connection: { id: string }; latency: number | null };

type ServerOptions = {
  withKeepalive?: { pingIntervalMs: number; idleTimeoutMs: number };
  hibernation?: boolean;
  onPing?: (ctx: unknown) => void;
  onPong?: (ctx: unknown) => void;
};

function buildEngine(options: ServerOptions = {}): Engine {
  const base = server({
    ...(options.hibernation ? { hibernation: true } : {}),
    capabilities: options.withKeepalive ? [keepalive(options.withKeepalive)] : [],
    ...(options.onPing ? { onPing: options.onPing } : {}),
    ...(options.onPong ? { onPong: options.onPong } : {}),
  });

  const noop = base.on('noop', { run() {} });
  const definition = base.assemble({ handlers: [noop] });

  let engine!: Engine;
  const runAdapter = adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    ...(options.hibernation
      ? { hibernation: { persist: () => {}, restore: () => undefined } }
      : {}),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),

        platform: { kind: 'test' },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  });
  runAdapter(definition, {} as never);

  return engine;
}

async function connect(engine: Engine) {
  await engine.initialize();
  const socket = testSocket();
  const handle = engine.accept(Symbol('ws'), socket.descriptor);
  // `accept` starts the connect lifecycle without awaiting it.
  await Promise.resolve();

  return { socket, handle };
}

describe('a ping the socket refused', () => {
  it('reports the send as failed, so a later pong measures nothing', async () => {
    vi.useFakeTimers();
    try {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 1_000, idleTimeoutMs: 10_000 },
      });
      await engine.initialize();
      const pingAttempts: string[] = [];
      const handle = engine.accept(Symbol('ws'), {
        send: (data: string) => {
          if (data === 'ping') pingAttempts.push(data);
          return data !== 'ping';
        },
        close: () => {},
        bufferedAmount: () => 0,
        userId: 'tester',
      });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_000);
      await handle.handleMessage('pong');

      const [connection] = engine.core.connections.values();
      expect(pingAttempts).toHaveLength(1);
      expect(connection?.latency).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the heartbeat hooks', () => {
  describe('a server with no keepalive()', () => {
    it('still answers a client ping with a pong', async () => {
      const { socket, handle } = await connect(buildEngine());

      await handle.handleMessage('ping');

      expect(socket.frames).toEqual(['pong']);
    });

    it('sends no ping of its own, ever', async () => {
      vi.useFakeTimers();
      const { socket } = await connect(buildEngine());

      vi.advanceTimersByTime(300_000);

      expect(socket.frames).not.toContain('ping');
      vi.useRealTimers();
    });

    it('records no latency, because nothing measured one', async () => {
      const { socket, handle } = await connect(buildEngine());

      await handle.handleMessage('pong');

      expect(socket.frames).toEqual([]);
    });
  });

  describe('onPing', () => {
    it('runs after the engine has already answered the client', async () => {
      // The hook reads the frames written so far, so it can prove the engine's
      // own pong reply went out before the app hook was given a turn.
      const framesAtHookTime: string[] = [];
      let liveFrames: string[] = [];
      const engine = buildEngine({
        onPing: () => void framesAtHookTime.push(...liveFrames),
      });
      const { socket, handle } = await connect(engine);
      liveFrames = socket.frames;

      await handle.handleMessage('ping');

      expect(framesAtHookTime).toEqual(['pong']);
    });

    it('receives a context for the connection that pinged', async () => {
      const seen: string[] = [];
      const engine = buildEngine({
        onPing: (ctx) => void seen.push((ctx as HeartbeatCtx).connection.id),
      });
      const { handle } = await connect(engine);

      await handle.handleMessage('ping');

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^conn_/);
    });

    it('does not fire on a pong', async () => {
      const onPing = vi.fn();
      const { handle } = await connect(buildEngine({ onPing }));

      await handle.handleMessage('pong');

      expect(onPing).not.toHaveBeenCalled();
    });
  });

  describe('onPong', () => {
    it('does not fire on a ping', async () => {
      const onPong = vi.fn();
      const { handle } = await connect(buildEngine({ onPong }));

      await handle.handleMessage('ping');

      expect(onPong).not.toHaveBeenCalled();
    });

    it('fires with a context when a client answers a ping', async () => {
      const seen: string[] = [];
      const { handle } = await connect(
        buildEngine({ onPong: (ctx) => void seen.push((ctx as HeartbeatCtx).connection.id) }),
      );

      await handle.handleMessage('pong');

      expect(seen).toHaveLength(1);
    });

    it('sees the latency keepalive measured, because keepalive runs first', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);

      const measured: Array<number | null> = [];
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 15_000, idleTimeoutMs: 30_000 },
        onPong: (ctx) => void measured.push((ctx as HeartbeatCtx).latency),
      });
      const { socket, handle } = await connect(engine);

      vi.advanceTimersByTime(15_000);
      expect(socket.frames).toContain('ping');

      vi.setSystemTime(Date.now() + 120);
      await handle.handleMessage('pong');

      // keepalive's onPong is registered at capability time, the app's at
      // lifecycle time, so the measurement has already landed.
      expect(measured).toEqual([120]);
      vi.useRealTimers();
    });
  });

  // A `pong` carries no id, so `keepalive()` can only tell which ping it answers
  // by being the only thing that sends one. Anything that hands app code a way
  // to send a ping reintroduces a second sender, and keepalive starts timing
  // the wrong ping. These tests pin that invariant.
  describe('keepalive() is the only thing that sends a ping', () => {
    it('gives the connection context no way to send one', async () => {
      const contexts: unknown[] = [];
      const engine = buildEngine({ onPong: (ctx) => void contexts.push(ctx) });
      const { handle } = await connect(engine);

      await handle.handleMessage('pong');

      expect(contexts).toHaveLength(1);
      expect(contexts[0]).not.toHaveProperty('ping');
    });

    it('emits no ping from a server without keepalive(), whatever the client does', async () => {
      const { socket, handle } = await connect(buildEngine());

      await handle.handleMessage(JSON.stringify(['noop', {}, null]));
      await handle.handleMessage('ping');
      await handle.handleMessage('pong');

      expect(socket.frames).not.toContain('ping');
    });
  });

  describe('a server with keepalive()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('pings on the configured interval', async () => {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 5_000, idleTimeoutMs: 20_000 },
      });
      const { socket } = await connect(engine);

      vi.advanceTimersByTime(4_999);
      expect(socket.frames).not.toContain('ping');

      vi.advanceTimersByTime(1);
      expect(socket.frames).toContain('ping');
    });

    it('still answers a client ping with a pong', async () => {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 5_000, idleTimeoutMs: 20_000 },
      });
      const { socket, handle } = await connect(engine);

      await handle.handleMessage('ping');

      expect(socket.frames).toEqual(['pong']);
    });

    it('does not ping under hibernation', async () => {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 5_000, idleTimeoutMs: 20_000 },
        hibernation: true,
      });
      const { socket } = await connect(engine);

      vi.advanceTimersByTime(60_000);

      expect(socket.frames).not.toContain('ping');
    });

    it('stops pinging once the connection closes', async () => {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 5_000, idleTimeoutMs: 20_000 },
      });
      const { socket, handle } = await connect(engine);

      await handle.handleClose(1000, 'bye');
      socket.frames.length = 0;
      vi.advanceTimersByTime(60_000);

      expect(socket.frames).toEqual([]);
    });

    it('releases the ping timer even when a disconnect hook throws', async () => {
      const engine = buildEngine({
        withKeepalive: { pingIntervalMs: 5_000, idleTimeoutMs: 20_000 },
      });
      const { handle } = await connect(engine);

      // A hook registered ahead of keepalive's teardown, throwing, must not be
      // able to strand the ping timer. Teardown runs in the engine's cleanup.
      engine.core.hooks.disconnect.unshift(() => {
        throw new Error('disconnect hook failed');
      });

      const timersBefore = vi.getTimerCount();
      expect(timersBefore).toBeGreaterThan(0);

      await handle.handleClose(1000, 'bye');

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
