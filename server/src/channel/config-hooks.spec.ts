import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

async function startEngine(definition: Parameters<ReturnType<typeof adapter>>[0]): Promise<Engine> {
  let engine!: Engine;
  adapter({
    id: 'channel-hooks-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();
  return engine;
}

async function connect(engine: Engine) {
  const sent: unknown[][] = [];
  const handle = engine.accept(Symbol('ama'), {
    send: (data: string) => sent.push(JSON.parse(data) as unknown[]),
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'ama',
  });
  await [...engine.core.connections.values()].at(-1)?.lifecycleReady;
  return { handle, sent };
}

const inRoom = { channel: { name: 'room' } };

describe('channel hooks written in the config', () => {
  it('runs onSubscribe, onUnsubscribe, onSessionEnd and intercept', async () => {
    const calls: string[] = [];
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      onSubscribe() {
        calls.push('onSubscribe');
      },
      onUnsubscribe() {
        calls.push('onUnsubscribe');
      },
      onSessionEnd() {
        calls.push('onSessionEnd');
      },
      intercept() {
        calls.push('intercept');
      },
    });
    const handleSay = room.on('say', { input: v.object({}), run() {} });
    const engine = await startEngine(base.assemble({ handlers: [handleSay] }));

    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));
    expect(calls).toEqual(['onSubscribe']);

    await handle.handleMessage(JSON.stringify(['say', {}, inRoom]));
    expect(calls).toContain('intercept');

    await handle.handleMessage(JSON.stringify(['__unsubscribe__', null, inRoom]));
    expect(calls).toContain('onUnsubscribe');
    expect(calls).toContain('onSessionEnd');
  });

  it('runs the hooks of a channel passed with no handlers', async () => {
    const calls: string[] = [];
    const base = server({ capabilities: [channels()] });
    const announcements = base.channel('room', {
      onSubscribe() {
        calls.push('onSubscribe');
      },
    });
    const engine = await startEngine(base.assemble({ handlers: [announcements] }));
    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));

    expect(calls).toEqual(['onSubscribe']);
  });

  it('runs the config hooks before the handler they guard', async () => {
    const calls: string[] = [];
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      intercept() {
        calls.push('intercept');
      },
    });
    const handleSay = room.on('say', {
      input: v.object({}),
      run() {
        calls.push('handler');
      },
    });
    const engine = await startEngine(base.assemble({ handlers: [handleSay] }));

    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));
    await handle.handleMessage(JSON.stringify(['say', {}, inRoom]));

    expect(calls).toEqual(['intercept', 'handler']);
  });

  it('has no method to register a hook after the channel is created', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room') as unknown as Record<string, unknown>;
    for (const hook of ['subscribe', 'unsubscribe', 'sessionEnd', 'intercept']) {
      expect(room[hook]).toBeUndefined();
    }
  });
});

describe('a channel stays the same after it is created', () => {
  it('turns on only the handlers passed to assemble()', async () => {
    const calls: string[] = [];
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room');
    const handleOn = room.on('on', {
      input: v.object({}),
      run() {
        calls.push('on');
      },
    });
    room.on('off', {
      input: v.object({}),
      run() {
        calls.push('off');
      },
    });

    const engine = await startEngine(base.assemble({ handlers: [handleOn] }));
    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));
    await handle.handleMessage(JSON.stringify(['on', {}, inRoom]));
    await handle.handleMessage(JSON.stringify(['off', {}, inRoom]));

    expect(calls).toEqual(['on']);
  });

  it('builds separate definitions from one channel, each with its own handlers', async () => {
    const calls: string[] = [];
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room');
    function handlerFor(event: string) {
      return room.on(event, {
        input: v.object({}),
        run() {
          calls.push(event);
        },
      });
    }

    const handleFirst = handlerFor('first');
    const first = base.assemble({ handlers: [handleFirst] });
    const handleSecond = handlerFor('second');
    const second = base.assemble({ handlers: [handleSecond] });

    const firstEngine = await startEngine(first);
    const secondEngine = await startEngine(second);
    for (const [engine, event] of [
      [firstEngine, 'second'],
      [secondEngine, 'first'],
      [secondEngine, 'second'],
    ] as const) {
      const { handle } = await connect(engine);
      await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));
      await handle.handleMessage(JSON.stringify([event, {}, inRoom]));
    }

    expect(calls).toEqual(['second']);
  });

  it('keeps a per-handler rate limit on the handler passed to assemble()', async () => {
    const base = server({ capabilities: [channels(), rateLimit({ max: 100, windowMs: 60_000 })] });
    const room = base.channel('room');
    const calls: string[] = [];
    const handleSay = room.on('say', {
      input: v.object({}),
      rateLimit: { max: 1 },
      run() {
        calls.push('say');
      },
    });
    const engine = await startEngine(base.assemble({ handlers: [handleSay] }));

    const { handle } = await connect(engine);

    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, inRoom]));
    await handle.handleMessage(JSON.stringify(['say', {}, inRoom]));
    await handle.handleMessage(JSON.stringify(['say', {}, inRoom]));

    expect(calls).toEqual(['say']);
  });
});

describe('assemble() refuses the same event twice in one scope', () => {
  it('throws for a plain list with the same event twice on one channel', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room');
    const list = [
      room.on('say', { input: v.object({}), run() {} }),
      room.on('say', { input: v.object({}), run() {} }),
    ];

    expect(() => base.assemble({ handlers: list })).toThrow(
      /Duplicate event 'say' on channel 'room'/,
    );
  });

  it('throws when an event and a request share a name on one channel', () => {
    const base = server({ capabilities: [channels(), clientRequests()] });
    const room = base.channel('room');
    const list = [
      room.on('say', { input: v.object({}), run() {} }),
      room.request('say', { run: () => ({ ok: true }) }),
    ];

    expect(() => base.assemble({ handlers: list })).toThrow(
      /Duplicate event 'say' on channel 'room'/,
    );
  });

  it('allows the same event on two channels', () => {
    const base = server({ capabilities: [channels()] });
    const list = [
      base.channel('room').on('say', { input: v.object({}), run() {} }),
      base.channel('lobby').on('say', { input: v.object({}), run() {} }),
    ];

    expect(() => base.assemble({ handlers: list })).not.toThrow();
  });

  it('throws for one channel handler passed twice', () => {
    const base = server({ capabilities: [channels()] });
    const handleSay = base.channel('room').on('say', { input: v.object({}), run() {} });
    const list = [handleSay];

    expect(() => base.assemble({ handlers: [...list, ...list] })).toThrow(
      /Duplicate event 'say' on channel 'room'/,
    );
  });
});

describe('base.scheduled returns a handler', () => {
  function taskBase() {
    return server({
      capabilities: [
        emits({ digest: t<{ userId: string }>() }),
        scheduled({ 'send-digest': { data: t<{ userId: string }>() } }),
      ],
    });
  }

  function taskCount(definition: { primitives: readonly { __livething: string }[] }) {
    return definition.primitives.filter((p) => p.__livething === 'scheduled').length;
  }

  it('includes the task when its handler is passed to assemble()', () => {
    const base = taskBase();
    const handleSendDigest = base.scheduled('send-digest', { run() {} });

    expect(taskCount(base.assemble({ handlers: [handleSendDigest] }))).toBe(1);
  });

  it('throws when a declared task has no handler passed', () => {
    const base = taskBase();
    base.scheduled('send-digest', { run() {} });
    const noHandlers: never[] = [];

    expect(() => base.assemble({ handlers: noHandlers })).toThrow(
      /Pass base\.scheduled\('send-digest', \.\.\.\) to assemble\(\)/,
    );
  });

  it('throws when a task handler has no declaration', () => {
    const base = server({}) as unknown as {
      scheduled?: unknown;
      assemble(config: { handlers: unknown[] }): unknown;
    };
    const stray = { __livethingScheduledTask: true, taskId: 'stray', run() {} };

    expect(() => base.assemble({ handlers: [stray] })).toThrow(/'stray'.*no matching declaration/);
  });

  it('throws when two handlers in a plain list run the same task', () => {
    const base = taskBase();
    const list = [
      base.scheduled('send-digest', { run() {} }),
      base.scheduled('send-digest', { run() {} }),
    ];

    expect(() => base.assemble({ handlers: list })).toThrow(
      /Duplicate scheduled task 'send-digest'/,
    );
  });

  it('ignores a handler created after assemble() and not passed', () => {
    const base = taskBase();
    const handleSendDigest = base.scheduled('send-digest', { run() {} });
    const definition = base.assemble({ handlers: [handleSendDigest] });
    base.scheduled('send-digest', { run() {} });

    expect(taskCount(definition)).toBe(1);
  });

  it('includes a task whose handler a plugin passes to its own assemble()', async () => {
    const { plugin } = await import('~/_define/plugins.ts');
    const polls = server({
      scope: 'plugin',
      capabilities: [scheduled({ 'close-polls': null })],
    });
    const handleClosePolls = polls.scheduled('close-polls', { run() {} });
    const Polls = plugin('acme:polls', {
      definition: polls.assemble({ handlers: [handleClosePolls] }),
    });
    const host = server({ capabilities: [Polls()] });

    const definition = host.assemble({ handlers: [] });

    expect(taskCount(definition)).toBeGreaterThan(0);
  });
});
