import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { intercept } from './intercept.ts';
import { runIntercepts } from './runtime.ts';
import type { FrameOwner, InterceptFrame, InterceptHandler } from './intercept.ts';

type AsyncContextStore = {
  connectionId?: string;
  [key: PropertyKey]: unknown;
};

function createConnection(): RuntimeConnection {
  return {
    id: 'c1',
    userId: 'c1',
    wsKey: 'ws1',
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: 'c1',
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function getCtx(): Record<PropertyKey, unknown> {
  return {};
}

function makeFrame(event: string, payload: unknown): InterceptFrame {
  return { event, payload, kind: 'incoming', routing: {}, owner: { kind: 'app' } };
}

function ownedIntercept(id: string, observesHost: boolean, handler: InterceptHandler) {
  return {
    ...intercept(handler),
    __owner: { kind: 'plugin' as const, id },
    __observesHost: observesHost,
  };
}

function makeRuntime() {
  return {
    asyncContext: new AsyncLocalStorage<AsyncContextStore>(),
  };
}

describe('intercept/runtime', () => {
  it('runs intercepts in order and lets them rewrite the payload', async () => {
    const connection = createConnection();

    const first = intercept(async (_ctx, frame) => ({
      ...(frame.payload as Record<string, unknown>),
      a: 1,
    }));
    const second = intercept(async (_ctx, frame) => ({
      ...(frame.payload as Record<string, unknown>),
      b: 2,
    }));

    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [first, second],
      frame: makeFrame('hello', {}),
      getCtx,
    });

    expect(next.event).toBe('hello');
    expect(next.payload).toEqual({ a: 1, b: 2 });
  });

  it('builds the connection context once and shares it across intercepts', async () => {
    const connection = createConnection();

    let builds = 0;
    function countingGetCtx(): Record<PropertyKey, unknown> {
      builds += 1;
      return { build: builds };
    }

    const seen: unknown[] = [];
    const a = intercept((ctx) => {
      seen.push(ctx);
      return undefined;
    });
    const b = intercept((ctx) => {
      seen.push(ctx);
      return undefined;
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [a, b],
      frame: makeFrame('e', {}),
      getCtx: countingGetCtx,
    });

    expect(builds).toBe(1);
    expect(seen[0]).toBe(seen[1]);
  });

  it('does not build a context when there are no intercepts', async () => {
    const connection = createConnection();
    let builds = 0;

    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [],
      frame: makeFrame('e', { keep: true }),
      getCtx: () => {
        builds += 1;
        return {};
      },
    });

    expect(builds).toBe(0);
    expect(next.payload).toEqual({ keep: true });
  });

  it('locks the event name: a returned {event, payload} object becomes the new payload as a whole', async () => {
    const connection = createConnection();

    // User code that "tries" to rewrite the event by returning a full
    // {event, payload} shape. The engine must NOT route based on this —
    // the wrapper object becomes the new payload verbatim.
    const aliasing = intercept(async () => ({
      event: 'real',
      payload: { count: 7 },
    }));

    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [aliasing],
      frame: makeFrame('alias', { ignored: true }),
      getCtx,
    });

    // Event stays locked at the wire-level 'alias'. The whole returned
    // object becomes frame.payload.
    expect(next.event).toBe('alias');
    expect(next.payload).toEqual({ event: 'real', payload: { count: 7 } });
  });

  it('void return passes the payload through unchanged', async () => {
    const connection = createConnection();

    const passthrough = intercept(() => undefined);

    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [passthrough],
      frame: makeFrame('foo', { keep: true }),
      getCtx,
    });

    expect(next.payload).toEqual({ keep: true });
  });

  it('null and other falsy non-undefined returns ARE treated as the new payload', async () => {
    // Only `undefined` means "no change". `null`, `0`, `false`, `''` are
    // valid replacement payloads.
    const connection = createConnection();

    const nuller = intercept(() => null);

    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [nuller],
      frame: makeFrame('foo', { original: true }),
      getCtx,
    });

    expect(next.payload).toBeNull();
  });

  it('Block in an intercept still propagates as an error', async () => {
    const { Block } = await import('@wskit/core');
    const connection = createConnection();

    const blocker = intercept(async () => {
      throw Block;
    });

    await expect(
      runIntercepts(makeRuntime(), connection, {
        intercepts: [blocker],
        frame: makeFrame('test', {}),
        getCtx,
      }),
    ).rejects.toBe(Block);
  });

  it('preserves kind and routing across the chain', async () => {
    const connection = createConnection();

    const seen: InterceptFrame[] = [];
    const recorder = intercept((_ctx, frame) => {
      seen.push(frame);
      return { stamped: true };
    });
    const second = intercept((_ctx, frame) => {
      seen.push(frame);
      return undefined;
    });

    const start: InterceptFrame = {
      event: 'go',
      payload: { v: 1 },
      kind: 'request',
      routing: { correlationId: 'abc-123' },
      owner: { kind: 'app' },
    };
    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [recorder, second],
      frame: start,
      getCtx,
    });

    expect(seen[0]?.kind).toBe('request');
    expect(seen[0]?.routing.correlationId).toBe('abc-123');
    expect(seen[1]?.payload).toEqual({ stamped: true });
    expect(seen[1]?.kind).toBe('request');
    expect(seen[1]?.routing.correlationId).toBe('abc-123');
    expect(next.kind).toBe('request');
    expect(next.routing.correlationId).toBe('abc-123');
  });

  it('exposes frame.owner to the handler and preserves it across a payload rewrite', async () => {
    const connection = createConnection();
    const seen: InterceptFrame[] = [];

    const recorder = intercept((_ctx, frame) => {
      seen.push(frame);
      return { rewritten: true };
    });
    const second = intercept((_ctx, frame) => {
      seen.push(frame);
    });

    const start: InterceptFrame = {
      event: 'chat',
      payload: { v: 1 },
      kind: 'incoming',
      routing: {},
      owner: { kind: 'app' },
    };
    const next = await runIntercepts(makeRuntime(), connection, {
      intercepts: [recorder, second],
      frame: start,
      getCtx,
    });

    expect(seen[0]?.owner).toEqual({ kind: 'app' });
    // Owner survives even though the first intercept rewrote the payload.
    expect(seen[1]?.owner).toEqual({ kind: 'app' });
    expect(seen[1]?.payload).toEqual({ rewritten: true });
    expect(next.owner).toEqual({ kind: 'app' });
  });

  it('runs an app intercept for an app frame and for a plugin frame', async () => {
    const connection = createConnection();
    const seen: string[] = [];
    const appHook = intercept((_ctx, frame) => {
      seen.push(frame.event);
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [appHook],
      frame: makeFrame('chat', {}),
      getCtx,
    });
    await runIntercepts(makeRuntime(), connection, {
      intercepts: [appHook],
      frame: { ...makeFrame('__a:p::beat', {}), owner: { kind: 'plugin', id: 'a:p' } },
      getCtx,
    });

    // The app sees both frames; the plugin frame keeps its wire name for the app.
    expect(seen).toEqual(['chat', '__a:p::beat']);
  });

  it('runs a plugin intercept for its own frame (short name) but NOT for an app frame', async () => {
    const connection = createConnection();
    const seen: string[] = [];
    const hook = ownedIntercept('a:p', false, (_ctx, frame) => {
      seen.push(frame.event);
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [hook],
      frame: { ...makeFrame('__a:p::beat', {}), owner: { kind: 'plugin', id: 'a:p' } },
      getCtx,
    });
    await runIntercepts(makeRuntime(), connection, {
      intercepts: [hook],
      frame: makeFrame('chat', {}),
      getCtx,
    });

    // Only its own frame fired, presented with the SHORT declared name.
    expect(seen).toEqual(['beat']);
  });

  it('does NOT run a plugin intercept for a sibling plugin frame', async () => {
    const connection = createConnection();
    let fired = false;
    const hook = ownedIntercept('a:p', true, () => {
      fired = true;
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [hook],
      frame: { ...makeFrame('__b:q::beat', {}), owner: { kind: 'plugin', id: 'b:q' } },
      getCtx,
    });

    // Sibling isolation holds even with host observation granted.
    expect(fired).toBe(false);
  });

  it('runs a host-observing plugin intercept for an app frame, with frame.owner = app', async () => {
    const connection = createConnection();
    const owners: FrameOwner[] = [];
    const events: string[] = [];
    const hook = ownedIntercept('a:p', true, (_ctx, frame) => {
      owners.push(frame.owner);
      events.push(frame.event);
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [hook],
      frame: makeFrame('chat', {}),
      getCtx,
    });
    await runIntercepts(makeRuntime(), connection, {
      intercepts: [hook],
      frame: { ...makeFrame('__a:p::beat', {}), owner: { kind: 'plugin', id: 'a:p' } },
      getCtx,
    });

    // The app frame keeps its name and app owner; its own frame is short + plugin owner.
    expect(events).toEqual(['chat', 'beat']);
    expect(owners[0]).toEqual({ kind: 'app' });
    expect(owners[1]).toEqual({ kind: 'plugin', id: 'a:p' });
  });
});
