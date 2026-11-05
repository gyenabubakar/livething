/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { serverRequestKey } from '~/request/outgoing-runtime.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';

const inRoom = { channel: { name: 'room' } };
const subscribeFrame = JSON.stringify(['__subscribe__', {}, inRoom]);

async function startEngine(definition: Parameters<ReturnType<typeof adapter>>[0]) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let engine!: Engine;
  adapter({
    id: 'assemble-config-checks-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: createTestStorage(),
        timers: createTestTimers(),
        platform: {},
        logger,
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();

  return { engine, logger };
}

async function connect(engine: Engine, userId = 'ama') {
  const sent: unknown[][] = [];
  const handle = engine.accept(Symbol(userId), {
    send: ({ text }: { kind: 'text'; text: string }) => sent.push(JSON.parse(text) as unknown[]),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)?.lifecycleReady;
  return { handle, sent };
}

function validationMessages(sent: unknown[][]): string[] {
  const error = sent.find((frame) => frame[0] === '__error__');
  const payload = error?.[1] as
    | { code: string; detail: { issues: { message: string }[] } }
    | undefined;
  expect(payload?.code).toBe('validation-failed');
  return payload!.detail.issues.map((issue) => issue.message);
}

describe('assemble() refuses a value from a different base', () => {
  function twoBases() {
    function digestBase() {
      return server({ capabilities: [channels(), scheduled({ 'send-digest': null })] }) as any;
    }

    return { other: digestBase(), own: digestBase() };
  }

  it('throws on a top-level handler', () => {
    const { other, own } = twoBases();
    const handleSay = other.on('say', { run() {} });
    const handleDigest = own.scheduled('send-digest', { run() {} });

    expect(() => own.assemble({ handlers: [handleSay, handleDigest] })).toThrow(/\[livething\]/);
  });

  it('throws on a channel handler', () => {
    const { other, own } = twoBases();
    const handleSay = other.channel('room').on('say', { run() {} });
    const handleDigest = own.scheduled('send-digest', { run() {} });

    expect(() => own.assemble({ handlers: [handleSay, handleDigest] })).toThrow(/\[livething\]/);
  });

  it('throws on a channel', () => {
    const { other, own } = twoBases();
    const room = other.channel('room');
    const handleDigest = own.scheduled('send-digest', { run() {} });

    expect(() => own.assemble({ handlers: [room, handleDigest] })).toThrow(/\[livething\]/);
  });

  it('throws on a scheduled handler', () => {
    const { other, own } = twoBases();
    const handleDigest = other.scheduled('send-digest', { run() {} });

    expect(() => own.assemble({ handlers: [handleDigest] })).toThrow(/\[livething\]/);
  });
});

describe('channel serverRequests declarations belong to their definition', () => {
  function roomAsking(base: any, input: v.GenericSchema, outcomes: string[]) {
    return base.channel('room', {
      capabilities: [serverRequests({ confirm: { out: t<{}>(), in: input } })],
      async onSubscribe(ctx: any) {
        try {
          await ctx.channel.request('confirm', {}, { timeout: 500 });
          outcomes.push('accepted');
        } catch (error) {
          outcomes.push(`failed:${(error as { code?: string }).code}`);
        }
      },
    });
  }

  async function answer(engine: Engine, payload: unknown) {
    const { handle, sent } = await connect(engine);
    const subscribing = handle.handleMessage(subscribeFrame);
    await vi.waitFor(() => expect(sent.some((frame) => frame[0] === 'confirm')).toBe(true));
    const request = sent.find((frame) => frame[0] === 'confirm')!;
    const { exchange } = request[2] as { exchange: { id: string } };

    await handle.handleMessage(
      JSON.stringify([
        'confirm',
        payload,
        { exchange: { id: exchange.id, source: 'server' }, ...inRoom },
      ]),
    );
    await subscribing;
  }

  it('keeps separate validators for two definitions from one base', async () => {
    const base = server({ capabilities: [channels(), serverRequests({})] }) as any;
    const outcomes: string[] = [];
    const first = base.assemble({
      handlers: [roomAsking(base, v.object({ ok: v.boolean() }), outcomes)],
    });
    const second = base.assemble({
      handlers: [roomAsking(base, v.object({ note: v.string() }), outcomes)],
    });

    const { engine: firstEngine } = await startEngine(first);
    const { engine: secondEngine } = await startEngine(second);
    await answer(firstEngine, { ok: true });
    await answer(secondEngine, { note: 'on my way' });

    expect(outcomes).toEqual(['accepted', 'accepted']);
  });

  it('leaves out a channel never passed to assemble()', () => {
    const base = server({ capabilities: [channels(), serverRequests({})] }) as any;
    roomAsking(base, v.object({ ok: v.boolean() }), []);

    const definition = base.assemble({ handlers: [] });
    const carrier = definition.primitives.find((p: any) => p.__livething === 'server-requests');

    expect(carrier.__serverRequests.has(serverRequestKey('room', 'confirm'))).toBe(false);
  });
});

describe('a plugin onError', () => {
  it('runs for the plugin own onConnect failure', async () => {
    const boom = new Error('presence store is down');
    const seen: unknown[] = [];
    const presence = server({
      scope: 'plugin',
      onConnect() {
        throw boom;
      },
      onError(_ctx, error) {
        seen.push(error);
      },
    });

    const Presence = plugin('acme:presence', {
      definition: presence.assemble({ handlers: [] }),
    });
    const base = server({ capabilities: [Presence()] });
    const { engine } = await startEngine(base.assemble({ handlers: [] }));

    await connect(engine);

    expect(seen).toEqual([boom]);
  });
});

describe('an uncaught NotAMember', () => {
  it('does not log that the code is missing from the contract errors list', async () => {
    const refs = new Map<string, ConnectionRef>();
    const base = server({
      capabilities: [channels(), serverRequests({})],
      onConnect(ctx) {
        refs.set(ctx.user.id, ctx.connection);
      },
    });
    const room = base.channel('room', {
      capabilities: [serverRequests({ confirm: { out: t<{}>(), in: v.object({}) } })],
    });
    const handleAsk = room.on('ask', {
      async run(ctx) {
        await ctx.channel.request('confirm', {}, { to: refs.get('kofi')! });
      },
    });

    const { engine, logger } = await startEngine(base.assemble({ handlers: [handleAsk] }));
    const ama = await connect(engine, 'ama');
    await connect(engine, 'kofi');

    await ama.handle.handleMessage(subscribeFrame);
    await ama.handle.handleMessage(JSON.stringify(['ask', {}, inRoom]));

    expect(ama.sent.some((frame) => frame[0] === '__error__')).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('not declared'),
      expect.anything(),
    );
  });
});

describe('config checks at runtime, for JS users', () => {
  it('throws on an unknown key in server(), naming the key', () => {
    expect(() => server({ onConect() {} } as any)).toThrow(/onConect/);
  });

  it('throws on an unknown key in base.channel(), naming the key', () => {
    const base = server({ capabilities: [channels()] }) as any;

    expect(() => base.channel('room', { membershp: 'persistent' })).toThrow(/membershp/);
  });

  it('throws on a misspelled membership value', () => {
    const base = server({ capabilities: [channels()] }) as any;

    expect(() => base.channel('room', { membership: 'persistant' })).toThrow(/persistant/);
  });

  it.each([
    'check',
    'commit',
    'revalidate',
    'onSubscribe',
    'onUnsubscribe',
    'onSessionEnd',
    'intercept',
  ])('throws when the channel hook %s is not a function', (hook) => {
    const base = server({ capabilities: [channels()] }) as any;

    expect(() => base.channel('room', { [hook]: 'nope' })).toThrow(new RegExp(hook));
  });

  it.each(['onConnect', 'onDisconnect', 'onError', 'onOutgoing'])(
    'throws when the server hook %s is not a function',
    (hook) => {
      expect(() => server({ [hook]: 'x' } as any)).toThrow(new RegExp(hook));
    },
  );

  it('assemble({}) says handlers is required', () => {
    const base = server({}) as any;

    expect(() => base.assemble({})).toThrow(/\[livething\].*handlers/);
  });

  it('assemble() throws a LiveThing error on an undefined handler', () => {
    const base = server({}) as any;

    expect(() => base.assemble({ handlers: [undefined] })).toThrow(/\[livething\]/);
  });

  it('throws on a retry value that is not a boolean or an array', () => {
    expect(() => scheduled({ a: { retry: 'yes' } } as any)).toThrow(/retry/);
  });

  it('names the task and the index of a bad retry entry', () => {
    expect(() => scheduled({ 'send-digest': { retry: [100, 200, -5] } })).toThrow(
      /send-digest.*\b2\b/,
    );
  });

  it('throws at definition time on an event config with no run', () => {
    const base = server({}) as any;

    expect(() => base.on('q', {})).toThrow(/\[livething\]/);
  });
});

describe('a malformed protocol frame', () => {
  async function refuse(frame: unknown[]) {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room');
    const { engine } = await startEngine(base.assemble({ handlers: [room] }));
    const { handle, sent } = await connect(engine);

    await handle.handleMessage(JSON.stringify(frame));

    return validationMessages(sent);
  }

  it('gets no raw JS error text for null metadata', async () => {
    const messages = await refuse(['__subscribe__', null, null]);

    expect(messages.join(' ')).not.toMatch(/TypeError|Cannot use|operator/);
  });

  it('says what is wrong with malformed channel metadata', async () => {
    const messages = await refuse(['__subscribe__', {}, { channel: 'room' }]);

    expect(messages.join(' ')).not.toContain('Expected Array but received Array');
    expect(messages.join(' ')).toMatch(/channel/);
  });
});
