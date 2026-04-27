/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_builder/server-builder.ts';
import { Engine } from '~/_engine/engine.ts';
import { withDedup } from '~/dedup/with.ts';
import { event } from '~/event.ts';
import { withHibernation } from '~/hibernation/with.ts';
import { withIntercept } from '~/intercept/with.ts';
import { defineModule } from '~/modules/define.ts';
import { withReplay } from '~/replay/with.ts';
import { withSequence } from '~/sequence/with.ts';
import { describe, expect, it, vi } from 'vitest';

function fakeSqlResult<TRow = unknown>(rows: Record<string, unknown>[] = []) {
  return {
    toArray: () => [...rows] as TRow[],
    one: () => (rows[0] as TRow | undefined) ?? null,
    raw: () => rows.map((r) => Object.values(r)),
  };
}

function makeFakeStorage() {
  const execCalls: Array<{ query: string; params: unknown[] }> = [];
  function exec<TRow = unknown>(query: string, ...params: unknown[]) {
    execCalls.push({ query, params });
    return fakeSqlResult<TRow>([]);
  }
  const sql = {
    exec,
    transaction<T>(fn: (tx: any) => T) {
      return fn({ exec });
    },
  };
  const kv = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
  return { storage: { sql, kv }, execCalls };
}

function makeTimers() {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    timers: {
      setTimeout: (fn: () => void, _ms: number) => {
        const h = ++nextHandle;
        handles.set(h, fn);
        return h;
      },
      clearTimeout: (h: unknown) => {
        handles.delete(h);
      },
    },
    handles,
  };
}

function setupEngine(def: any) {
  const engine = new Engine(def, { adapterId: 'test', hibernation: false });
  const { storage, execCalls } = makeFakeStorage();
  const { timers } = makeTimers();
  engine.setStorage(storage);
  engine.setTimerProvider(timers);
  engine.setEnv({});
  engine.setPlatform({});
  engine.setWaitUntil((p) => {
    void p;
  });
  return { engine, execCalls };
}

describe('module onIncoming wiring', () => {
  it('runs onIncoming from an installed module and can rewrite the message', async () => {
    const observed: Array<{ event: string; payload: unknown }> = [];

    const MOD_KEY = Symbol('tap');
    const tap = defineModule({
      id: 'acme:tap',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onIncoming((m) => {
          observed.push(m);
          return { event: m.event, payload: { ...(m.payload as any), seen: true } };
        });
        return () => ({});
      },
    });

    const handler = vi.fn();
    const hit = event('hit', (p: unknown) => p as { id: number });
    const def = server('chat').use(tap({})).incoming(hit, handler).build();

    const { engine } = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(JSON.stringify({ event: 'hit', payload: { id: 7 } }));

    expect(observed).toEqual([{ event: 'hit', payload: { id: 7 } }]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1]).toMatchObject({ id: 7, seen: true });
  });
});

describe('module onOutgoing wiring', () => {
  it('observes and can rewrite messages flowing through send()', async () => {
    const observed: Array<{ event: string; payload: unknown }> = [];

    const MOD_KEY = Symbol('obs');
    const obs = defineModule({
      id: 'acme:obs',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onOutgoing((m) => {
          observed.push(m);
          return { event: m.event, payload: { ...(m.payload as any), tagged: true } };
        });
        return () => ({});
      },
    });

    const go = event('go', (p: unknown) => p as {});
    const tick = event('tick', (p: unknown) => p as { n: number; tagged?: boolean });

    const def = server('chat')
      .use(obs({}))
      .outgoing(tick)
      .incoming(go, async (ctx) => {
        ctx.send('tick', { n: 1 });
      })
      .build();

    const sent: string[] = [];
    const { engine } = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send: (data) => sent.push(data as string),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(JSON.stringify({ event: 'go', payload: {} }));

    expect(observed).toEqual([{ event: 'tick', payload: { n: 1 } }]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ event: 'tick', payload: { n: 1, tagged: true } });
  });
});

describe('module scheduled task registration', () => {
  it('registers tasks under a module-prefixed id', async () => {
    const MOD_KEY = Symbol('cron');
    const handler = vi.fn();

    const cron = defineModule({
      id: 'acme:cron',
      key: MOD_KEY,
      requires: { timers: true, storage: true },
      setup(_args, hooks) {
        hooks.scheduled('tick', (t) => t.run(handler));
        return () => ({});
      },
    });

    const def = server('chat').use(cron({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    // Inspect the compiled scheduled map: only accessible via private, but we
    // can inspect via (engine as any).
    const compiled = (engine as any).compiled;
    expect(compiled.scheduled.has('__acme:cron:tick')).toBe(true);

    // The handler reference must match what the module registered.
    const entry = compiled.scheduled.get('__acme:cron:tick');
    expect(entry.handler).toBe(handler);
    expect(entry.taskId).toBe('__acme:cron:tick');
  });
});

describe('C8: module onIncoming runs before top-level pre-intercept', () => {
  it('pre-intercept sees the payload already mutated by module onIncoming', async () => {
    const interceptSaw: Array<{ event: string; payload: unknown }> = [];

    const MOD_KEY = Symbol('mutate');
    const mutate = defineModule({
      id: 'acme:mutate',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onIncoming((m) => {
          return { event: m.event, payload: { ...(m.payload as any), moduleAdded: true } };
        });
        return () => ({});
      },
    });

    const hit = event('hit', (p: unknown) => p as { id: number });

    const def = withIntercept(server('chat'))
      .use(mutate({}))
      .intercept((_ctx, m) => {
        interceptSaw.push({ event: m.event, payload: m.payload });
        return m;
      })
      .incoming(hit, async () => {})
      .build();

    const { engine } = setupEngine(def);
    await engine.initialize();
    const handle = engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });
    await handle.handleMessage(JSON.stringify({ event: 'hit', payload: { id: 42 } }));

    expect(interceptSaw).toHaveLength(1);
    expect(interceptSaw[0]!.payload).toMatchObject({ id: 42, moduleAdded: true });
  });
});

describe('module onInit wiring', () => {
  it('onInit callback fires during engine initialize()', async () => {
    let initFired = false;

    const MOD_KEY = Symbol('init');
    const initMod = defineModule({
      id: 'acme:init',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onInit(() => {
          initFired = true;
        });
        return () => ({});
      },
    });

    const def = server('chat').use(initMod({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    expect(initFired).toBe(true);
  });
});

describe('module getState fallback', () => {
  it('returns an empty ConnectionInfo shape when there is no active connection', async () => {
    let captured: unknown;
    const MOD_KEY = Symbol('state');

    const stateMod = defineModule({
      id: 'acme:state',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onInit(() => {
          // onInit runs with no active connection — getState should fall back.
          captured = hooks.getState();
        });
        return () => ({});
      },
    });

    const def = server('chat').use(stateMod({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    expect(captured).toEqual({
      id: '',
      meta: {},
      tags: [],
      channels: [],
      latency: null,
      quality: 'good',
      bufferedAmount: 0,
    });
  });
});

describe('module sandbox boundary', () => {
  it('the hooks object exposes only the documented ModuleHooks surface', async () => {
    const MOD_KEY = Symbol('inspect');
    let inspectedKeys: string[] = [];
    let leakedEngineRef: unknown = null;

    const inspector = defineModule({
      id: 'acme:inspect',
      key: MOD_KEY,
      setup(_args, hooks) {
        inspectedKeys = Object.keys(hooks).sort();

        // Walk every value on hooks and confirm none of them are the Engine or
        // any object exposing engine-internal fields like `compiled`,
        // `connections`, `activeStreams`, or `hooks`.
        for (const value of Object.values(hooks)) {
          const candidate = value as Record<string, unknown> | undefined;
          if (
            candidate &&
            typeof candidate === 'object' &&
            ('compiled' in candidate ||
              'connections' in candidate ||
              'activeStreams' in candidate ||
              'hooks' in candidate)
          ) {
            leakedEngineRef = candidate;
          }
        }

        return () => ({});
      },
    });

    const def = server('chat').use(inspector({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    expect(inspectedKeys).toEqual([
      'generateId',
      'getState',
      'onConnect',
      'onDisconnect',
      'onIncoming',
      'onInit',
      'onOutgoing',
      'onShutdown',
      'scheduled',
    ]);
    expect(leakedEngineRef).toBeNull();
  });

  it('getState returns a sanitized ConnectionInfo, never the raw RuntimeConnection', async () => {
    const MOD_KEY = Symbol('snapshot');
    let snapshot: unknown = null;

    const sniff = defineModule({
      id: 'acme:sniff',
      key: MOD_KEY,
      setup(_args, hooks) {
        hooks.onConnect(() => {
          snapshot = hooks.getState();
        });
        return () => ({});
      },
    });

    const def = server('chat').use(sniff({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    engine.accept(Symbol('ws'), {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });

    expect(snapshot).not.toBeNull();
    const fields = Object.keys(snapshot as Record<string, unknown>).sort();
    expect(fields).toEqual([
      'bufferedAmount',
      'channels',
      'id',
      'latency',
      'meta',
      'quality',
      'tags',
    ]);

    // None of the engine-internal fields should leak through getState.
    const obj = snapshot as Record<string, unknown>;
    expect('descriptor' in obj).toBe(false);
    expect('wsKey' in obj).toBe(false);
    expect('seenIncomingIds' in obj).toBe(false);
    expect('activeStreamIds' in obj).toBe(false);
  });

  it('two modules cannot reach each other’s scheduled task ids', async () => {
    const KEY_A = Symbol('mod-a');
    const KEY_B = Symbol('mod-b');
    let taskIdRegisteredByA = '';

    const modA = defineModule({
      id: 'acme:mod-a',
      key: KEY_A,
      requires: { timers: true, storage: true },
      setup(_args, hooks) {
        const handle = hooks.scheduled('tick', (t) => t.run(() => {}));
        taskIdRegisteredByA = handle.id;
        return () => ({});
      },
    });

    let visibleFromB: string[] = [];

    const modB = defineModule({
      id: 'acme:mod-b',
      key: KEY_B,
      requires: { timers: true, storage: true },
      setup(_args, hooks) {
        // Module B has no path to module A's scheduled task ids. The hooks
        // surface only exposes registration; there is no enumeration helper.
        visibleFromB = Object.keys(hooks);
        return () => ({});
      },
    });

    const def = server('chat').use(modA({})).use(modB({})).build();
    const { engine } = setupEngine(def);
    await engine.initialize();

    expect(taskIdRegisteredByA).toBe('__acme:mod-a:tick');
    expect(visibleFromB).not.toContain(taskIdRegisteredByA);
    expect(visibleFromB).not.toContain('compiled');
    expect(visibleFromB).not.toContain('connections');
  });
});

describe('engine requirements validation', () => {
  it('throws when replay() is registered without sequence({ persist: true })', async () => {
    const def = withReplay(withDedup(withSequence(server('chat'))))
      .sequence()
      .dedup()
      .replay((r) => r)
      .build();
    const { engine } = setupEngine(def);

    await expect(engine.initialize()).rejects.toThrow(/replay\(\) requires sequence/);
  });

  it('succeeds when replay() is paired with sequence({ persist: true })', async () => {
    const def = withReplay(withDedup(withSequence(server('chat'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r)
      .build();
    const { engine } = setupEngine(def);
    await expect(engine.initialize()).resolves.toBeUndefined();
  });

  it('throws when hibernation() is used but adapter does not support it', async () => {
    const def = withHibernation(server('chat')).hibernation().build();
    const engine = new Engine(def, { adapterId: 'no-hib', hibernation: false });
    const { storage } = makeFakeStorage();
    const { timers } = makeTimers();
    engine.setStorage(storage);
    engine.setTimerProvider(timers);
    engine.setWaitUntil(() => {});

    await expect(engine.initialize()).rejects.toThrow(/Handler requires hibernation/);
  });
});

describe('replay durability branching', () => {
  it('best-effort persists via onAfterSend (after the frame is sent)', async () => {
    const msg = event('msg', (p: unknown) => p as { text: string });
    const sendMsg = event('send-msg', (p: unknown) => p as { text: string });

    const def = withReplay(withDedup(withSequence(server('chat'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.durability('best-effort'))
      .outgoing(msg)
      .incoming(sendMsg, async (ctx, payload) => {
        ctx.send('msg', { text: payload.text });
      })
      .build();

    const engine = new Engine(def, { adapterId: 'best-effort', hibernation: false });
    const { storage, execCalls } = makeFakeStorage();
    const { timers } = makeTimers();
    engine.setStorage(storage);
    engine.setTimerProvider(timers);
    engine.setWaitUntil(() => {});

    await engine.initialize();
    let persistedAtSend = -1;
    const handle = engine.accept(Symbol('ws'), {
      send: () => {
        // With best-effort, persistence is deferred via Promise.resolve().then(...),
        // so when the descriptor.send() is called synchronously from the pipeline,
        // no replay row should have been written yet.
        persistedAtSend = execCalls.filter((c) =>
          c.query.includes('INSERT OR REPLACE INTO _wskit_replay'),
        ).length;
      },
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });

    await handle.handleMessage(JSON.stringify({ event: 'send-msg', payload: { text: 'hi' } }));

    expect(persistedAtSend).toBe(0);

    // Flush pending microtasks to allow onAfterSend's Promise.resolve().then(...) to run.
    await Promise.resolve();
    await Promise.resolve();
    const sendCountAfter = execCalls.filter((c) =>
      c.query.includes('INSERT OR REPLACE INTO _wskit_replay'),
    ).length;
    expect(sendCountAfter).toBeGreaterThanOrEqual(1);
  });

  it('strict persists via onBeforeSend (synchronously before the frame)', async () => {
    const msg = event('msg', (p: unknown) => p as { text: string });
    const sendMsg = event('send-msg', (p: unknown) => p as { text: string });

    const def = withReplay(withDedup(withSequence(server('chat'))))
      .sequence({ persist: true })
      .dedup()
      .replay((r) => r.durability('strict'))
      .outgoing(msg)
      .incoming(sendMsg, async (ctx, payload) => {
        ctx.send('msg', { text: payload.text });
      })
      .build();

    const engine = new Engine(def, { adapterId: 'strict', hibernation: false });
    const { storage, execCalls } = makeFakeStorage();
    const { timers } = makeTimers();
    engine.setStorage(storage);
    engine.setTimerProvider(timers);
    engine.setWaitUntil(() => {});

    await engine.initialize();
    const sent: string[] = [];
    const handle = engine.accept(Symbol('ws'), {
      send: (data) => {
        // At this point the strict onBeforeSend should have already persisted.
        const persistedByNow = execCalls.filter((c) =>
          c.query.includes('INSERT OR REPLACE INTO _wskit_replay'),
        ).length;
        expect(persistedByNow).toBeGreaterThanOrEqual(1);
        sent.push(data as string);
      },
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    });

    await handle.handleMessage(JSON.stringify({ event: 'send-msg', payload: { text: 'hi' } }));
    expect(sent).toHaveLength(1);
  });
});

describe('handleHibernationWake guard', () => {
  it('throws when hibernation() primitive is not registered', () => {
    const def = server('chat').build();
    const { engine } = setupEngine(def);
    expect(() => engine.handleHibernationWake(Symbol('ws'))).toThrow(
      '[wskit] hibernation() is not enabled for this handler.',
    );
  });

  it('throws when adapter supports hibernation but the hibernation() primitive was not registered', () => {
    const def = server('chat').build();
    const engine = new Engine(def, { adapterId: 'test', hibernation: true });
    // No hibernation() primitive → hibernationEnabled stays false → usesHibernation() = false
    expect(() => engine.handleHibernationWake(Symbol('ws'))).toThrow(
      '[wskit] hibernation() is not enabled for this handler.',
    );
  });
});
