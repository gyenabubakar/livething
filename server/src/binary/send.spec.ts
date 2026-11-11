import { AsyncLocalStorage } from 'node:async_hooks';
import { splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeOptions, TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';
import type { OutgoingFrame } from '~/intercept/intercept.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };
const picture = new Uint8Array([137, 80, 78, 71]);

function build(
  definition: ServerDefinition,
  messageLimits?: EngineRuntimeOptions['messageLimits'],
) {
  const logged: unknown[][] = [];
  let engine!: Engine;
  adapter({
    id: 'binary-send-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => logged.push(args) },
        ...(messageLimits ? { messageLimits } : {}),
      });
      return {};
    },
  })(definition, undefined as never);
  return { engine, logged };
}

interface Member {
  sent: TransportFrame[];
  binaryFrames: () => { envelope: unknown[]; bytes: number[]; raw: Uint8Array }[];
  texts: () => unknown[][];
  send: (event: string, payload?: unknown, metadata?: unknown) => Promise<void>;
}

async function connect(engine: Engine, userId: string): Promise<Member> {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => sent.push(data),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  return {
    sent,
    binaryFrames: () =>
      sent.flatMap((data) => {
        if (data.kind !== 'bytes') return [];

        const split = splitBinaryFrame(data.bytes);
        if (split.kind !== 'frame') throw new Error(`not a LiveThing frame: ${split.kind}`);

        return [{ envelope: JSON.parse(split.envelope), bytes: [...split.bytes], raw: data.bytes }];
      }),
    texts: () => sent.flatMap((data) => (data.kind === 'text' ? [JSON.parse(data.text)] : [])),
    send: (event, payload = null, metadata = null) =>
      handle.handleMessage(JSON.stringify([event, payload, metadata])),
  };
}

function huddle(results: unknown[], outgoing: OutgoingFrame[] = []) {
  const refs = new Map<string, ConnectionRef>();
  const base = server({
    capabilities: [
      binary({ emits: { 'avatar-preview': t<null>() } }),
      emits({ 'avatar-saved': t<{ userId: string }>() }),
      channels(),
      dedup(),
      sequence(),
      tags((ephemeral) => [ephemeral('team', t<string>())]),
    ],
    onConnect(ctx) {
      refs.set(ctx.connection.userId, ctx.connection);
    },
    onOutgoing(_ctx, frame) {
      outgoing.push(frame);
    },
  });
  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [
      binary({ emits: { 'screen-frame': t<{ from: string }>() } }),
      emits({ 'screen-share-started': t<{ from: string }>() }),
    ],
  });
  const handlers = [
    base.on('preview-avatar', {
      run(ctx) {
        results.push(ctx.binary.send('avatar-preview', null, picture));
      },
    }),
    base.on('preview-avatar-buffer', {
      run(ctx) {
        results.push(ctx.binary.send('avatar-preview', null, picture.slice().buffer));
      },
    }),
    base.on('preview-avatar-then-change', {
      run(ctx) {
        const bytes = picture.slice();
        ctx.binary.send('avatar-preview', null, bytes);
        bytes.fill(0);
      },
    }),
    base.on('preview-avatar-to-everyone', {
      run(ctx) {
        results.push(ctx.binary.broadcast('avatar-preview', null, picture, { includeSelf: true }));
      },
    }),
    base.on('preview-avatar-to-me', {
      run(ctx) {
        results.push(ctx.user.binary.broadcast('avatar-preview', null, picture));
        results.push(
          ctx.connections.get(refs.get('u_kofi')!).binary.send('avatar-preview', null, picture),
        );
      },
    }),
    base.on('preview-avatar-to-team', {
      run(ctx) {
        ctx.tags.ephemeral('team').add('design');
        ctx.tags.ephemeral('team').binary.broadcast('avatar-preview', null, picture);
        ctx.tags.ephemeral('team').ref('design').binary.broadcast('avatar-preview', null, picture);
      },
    }),
    base.on('send-wrong-kind', {
      run(ctx) {
        for (const send of [
          () => ctx.binary.send('avatar-saved' as never, null as never, picture),
          () => ctx.send('avatar-preview' as never, null as never),
          () => ctx.binary.send('avatar-preview', { name: 'x'.repeat(70_000) } as never, picture),
          () => ctx.binary.send('avatar-preview', null, 'not bytes' as never),
        ]) {
          try {
            send();
            results.push('sent');
          } catch (error) {
            results.push((error as Error).message);
          }
        }
      },
    }),
    rooms.on('start-screen-share', {
      run(ctx) {
        ctx.channel.broadcast('screen-share-started', { from: ctx.user.id });
        ctx.channel.binary.broadcast('screen-frame', { from: ctx.user.id }, picture);
      },
    }),
    rooms.on('send-frame-to-kofi', {
      run(ctx) {
        results.push(
          ctx.channel.binary.broadcastTo(
            refs.get('u_kofi')!,
            'screen-frame',
            { from: ctx.user.id },
            picture,
          ),
        );
        results.push(ctx.channel.binary.send('screen-frame', { from: ctx.user.id }, picture));
      },
    }),
    base.on('frame-to-design-room', {
      run(ctx) {
        ctx.channels
          .get(rooms.at({ roomId: 'design' }))
          .binary.broadcast('screen-frame', { from: ctx.user.id }, picture);
      },
    }),
  ];

  return { definition: base.assemble({ handlers: [...handlers, rooms] }), rooms };
}

describe('sending a binary event', () => {
  it('writes one binary frame whose envelope is a normal frame, and returns true', async () => {
    const results: unknown[] = [];
    const { engine } = build(huddle(results).definition);
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar');

    expect(results).toEqual([true]);
    const [sent] = amara.binaryFrames();
    expect(sent!.envelope).toEqual([
      'avatar-preview',
      null,
      { delivery: { id: expect.any(String), seq: expect.any(Number) } },
    ]);
    expect(sent!.bytes).toEqual([...picture]);
  });

  it('takes an ArrayBuffer, and copies the bytes so the caller can change them after', async () => {
    const { engine } = build(huddle([]).definition);
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar-buffer');
    await amara.send('preview-avatar-then-change');

    expect(amara.binaryFrames().map((sent) => sent.bytes)).toEqual([[...picture], [...picture]]);
  });

  it('reaches every audience the JSON senders reach, with the same return values', async () => {
    const results: unknown[] = [];
    const { engine } = build(huddle(results).definition);
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');

    await amara.send('preview-avatar-to-everyone');
    await amara.send('preview-avatar-to-me');
    await amara.send('preview-avatar-to-team');

    expect(results).toEqual([undefined, 1, true]);
    expect(amara.binaryFrames()).toHaveLength(4);
    expect(kofi.binaryFrames()).toHaveLength(2);
  });

  it('refuses the wrong kind of event, an envelope over 64 KiB and bytes of the wrong type', async () => {
    const results: unknown[] = [];
    const { engine } = build(huddle(results).definition);
    const amara = await connect(engine, 'u_amara');

    await amara.send('send-wrong-kind');

    expect(results).toEqual([
      expect.stringMatching(/"avatar-saved" is declared as a JSON event\. Send it with \.send/),
      expect.stringMatching(/"avatar-preview" is declared in binary\(\{ emits \}\)/),
      expect.stringMatching(/over the 64 KiB limit/),
      expect.stringMatching(/must be a Uint8Array or an ArrayBuffer/),
    ]);
    expect(amara.binaryFrames()).toEqual([]);
  });

  it('throws when the frame is over the adapter sendBytes', async () => {
    const results: unknown[] = [];
    const base = server({ capabilities: [binary({ emits: { 'avatar-preview': t<null>() } })] });
    const preview = base.on('preview-avatar', {
      run(ctx) {
        try {
          ctx.binary.send('avatar-preview', null, new Uint8Array(200));
        } catch (error) {
          results.push((error as Error).message);
        }
      },
    });
    const { engine } = build(base.assemble({ handlers: [preview] }), {
      receiveBytes: 1000,
      sendBytes: 100,
    });
    const amara = await connect(engine, 'u_amara');

    await amara.send('preview-avatar');

    expect(results).toEqual([expect.stringMatching(/over the send limit of 100 bytes/)]);
  });

  it('runs onOutgoing once, with the info as payload and the bytes', async () => {
    const outgoing: OutgoingFrame[] = [];
    const { engine } = build(huddle([], outgoing).definition);
    const amara = await connect(engine, 'u_amara');
    await connect(engine, 'u_kofi');

    await amara.send('preview-avatar-to-everyone');

    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({
      event: 'avatar-preview',
      payload: null,
      target: { kind: 'all' },
      recipients: 2,
    });
    expect([...outgoing[0]!.bytes!]).toEqual([...picture]);
  });
});

describe('a channel binary broadcast', () => {
  it('reaches each member as one shared binary frame, and shares the sequence with text', async () => {
    const { engine } = build(huddle([]).definition);
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    const ama = await connect(engine, 'u_ama');
    await amara.send('__subscribe__', {}, general);

    await kofi.send('__subscribe__', {}, general);
    await ama.send('__subscribe__', {}, general);

    await amara.send('start-screen-share', null, general);

    expect(amara.binaryFrames()).toEqual([]);
    const [kofiFrame] = kofi.binaryFrames();
    const [amaFrame] = ama.binaryFrames();
    expect(kofiFrame!.raw).toBe(amaFrame!.raw);
    expect(kofiFrame!.envelope).toEqual([
      'screen-frame',
      { from: 'u_amara' },
      {
        channel: { name: 'room:general', family: 'rooms' },
        delivery: { id: expect.any(String), seq: expect.any(Number) },
      },
    ]);

    expect(kofiFrame!.bytes).toEqual([...picture]);
    const started = kofi.texts().find((data) => data[0] === 'screen-share-started')!;
    const textSeq = (started[2] as { delivery: { seq: number } }).delivery.seq;
    const binarySeq = (kofiFrame!.envelope[2] as { delivery: { seq: number } }).delivery.seq;
    expect(binarySeq).toBe(textSeq + 1);
  });

  it('sends to one member with broadcastTo and to the caller with send', async () => {
    const results: unknown[] = [];
    const { engine } = build(huddle(results).definition);
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);

    await kofi.send('__subscribe__', {}, general);

    await amara.send('send-frame-to-kofi', null, general);

    expect(results).toEqual([1, 1]);
    expect(kofi.binaryFrames()).toHaveLength(1);
    expect(amara.binaryFrames()).toHaveLength(1);
  });

  it('reaches another channel through ctx.channels.get(...)', async () => {
    const { engine } = build(huddle([]).definition);
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    await kofi.send('__subscribe__', {}, { channel: { name: 'room:design', family: 'rooms' } });

    await amara.send('frame-to-design-room');

    expect(kofi.binaryFrames().map((sent) => sent.envelope[0])).toEqual(['screen-frame']);
  });

  it('goes out from the admin API and connectionless code', async () => {
    const { engine } = build(huddle([]).definition);
    const kofi = await connect(engine, 'u_kofi');
    await kofi.send('__subscribe__', {}, general);
    const admin = engine.admin() as unknown as {
      binary: { broadcast(event: string, info: unknown, bytes: Uint8Array): void };
      channels: {
        get(
          family: string,
          name: string,
        ): {
          binary: { broadcast(event: string, info: unknown, bytes: Uint8Array): void };
        };
        binary: {
          broadcast(
            channel: { family: string; name: string },
            event: string,
            info: unknown,
            bytes: Uint8Array,
          ): void;
        };
      };
    };

    admin.binary.broadcast('avatar-preview', null, picture);
    admin.channels
      .get('rooms', 'room:general')
      .binary.broadcast('screen-frame', { from: 'admin' }, picture);
    admin.channels.binary.broadcast(
      { family: 'rooms', name: 'room:general' },
      'screen-frame',
      { from: 'admin' },
      picture,
    );

    expect(kofi.binaryFrames().map((sent) => sent.envelope[0])).toEqual([
      'avatar-preview',
      'screen-frame',
      'screen-frame',
    ]);
  });
});

describe('binary and the other features', () => {
  it('gives no sender a .binary key without binary()', async () => {
    const seen: unknown[] = [];
    const base = server({ capabilities: [emits({ 'avatar-saved': t<null>() })] });
    const save = base.on('save-avatar', {
      run(ctx) {
        seen.push((ctx as unknown as { binary?: unknown }).binary);
        seen.push((ctx.user as unknown as { binary?: unknown }).binary);
      },
    });
    const { engine } = build(base.assemble({ handlers: [save] }));
    const amara = await connect(engine, 'u_amara');

    await amara.send('save-avatar');

    expect(seen).toEqual([undefined, undefined]);
  });
});

describe('declaring binary events and handlers', () => {
  it('needs binary() at the root for a channel binary() or binary handler', () => {
    const base = server({ capabilities: [channels()] });
    expect(() =>
      // @ts-expect-error: the root lists no binary()
      base.channel('room:general', {
        capabilities: [binary({ emits: { 'screen-frame': t<null>() } })],
      }),
    ).toThrow(/binary\(\) is not listed/);
    const rooms = base.channel('room:general', {});
    expect(() =>
      (rooms as unknown as { binary: { on(event: string, config: unknown): unknown } }).binary.on(
        'share-screen-frame',
        { run() {} },
      ),
    ).toThrow(/binary\(\) is not listed/);
    expect(() =>
      (base as unknown as { binary: { on(event: string, config: unknown): unknown } }).binary.on(
        'upload-avatar',
        { run() {} },
      ),
    ).toThrow(/base\.binary\.on\(\) needs binary\(\)/);
  });

  it('keeps one name for one declaration in a scope, across JSON and binary', async () => {
    const declared = server({
      capabilities: [
        binary({ emits: { 'avatar-preview': t<null>() } }),
        emits({ 'avatar-preview': t<null>() }),
      ],
    });
    expect(() => build(declared.assemble({ handlers: [] }))).toThrow(
      /Duplicate outgoing declaration for "avatar-preview"/,
    );

    const handled = server({ capabilities: [binary()] });
    expect(() =>
      handled.assemble({
        // @ts-expect-error: two handlers for one name
        handlers: [
          handled.on('upload-avatar', { run() {} }),
          handled.binary.on('upload-avatar', { run() {} }),
        ],
      }),
    ).toThrow(/Duplicate incoming handler for 'upload-avatar'/);
  });

  it('refuses reserved names', () => {
    expect(() => binary({ emits: { __preview: t<null>() } })).toThrow(/reserved '__' prefix/);
    expect(() => binary({ emits: { preview__: t<null>() } })).toThrow(/reserved '__' suffix/);
    const base = server({ capabilities: [binary()] });
    expect(() => base.binary.on('__upload', { run() {} })).toThrow(/reserved '__' prefix/);
  });

  it('refuses a name with :: when the engine is built', () => {
    const base = server({ capabilities: [binary({ emits: { 'avatar::preview': t<null>() } })] });

    expect(() => build(base.assemble({ handlers: [] }))).toThrow(/contains '::'/);
  });

  it('refuses an unknown binary() option and a maxBytes that is not a positive whole number', () => {
    expect(() => binary({ events: {} } as never)).toThrow(/unknown option 'events'/);
    const base = server({ capabilities: [binary()] });
    expect(() => base.binary.on('upload-avatar', { maxBytes: 0, run() {} })).toThrow(/maxBytes/);
  });

  it('refuses a binary event name over 128 characters when the engine is built', () => {
    const base = server({ capabilities: [binary({ emits: { ['a'.repeat(129)]: t<null>() } })] });

    expect(() => build(base.assemble({ handlers: [] }))).toThrow(/128/);
  });

  it('refuses a binary handler name over 128 characters when the engine is built', () => {
    const base = server({ capabilities: [binary()] });
    const handleLong = base.binary.on('a'.repeat(129), { run() {} });

    expect(() => build(base.assemble({ handlers: [handleLong] }))).toThrow(/128/);
  });
});

describe('a binary send over a size limit', () => {
  const bigInfo = { from: 'x'.repeat(70_000) };
  const bigBytes = new Uint8Array(2000);

  function limited(results: unknown[]) {
    const refs = new Map<string, ConnectionRef>();
    const base = server({
      capabilities: [
        binary({ emits: { 'avatar-preview': t<{ from: string }>() } }),
        channels(),
        tags((ephemeral) => [ephemeral('team', t<string>())]),
      ],
      onConnect(ctx) {
        refs.set(ctx.connection.userId, ctx.connection);
      },
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
    });
    function attempt(send: () => unknown) {
      try {
        results.push(send());
      } catch (error) {
        results.push(`throws: ${(error as Error).message}`);
      }
    }

    const handleSendTooBig = rooms.on('send-too-big', {
      run(ctx, input) {
        const { big } = input as { big: 'info' | 'bytes' };
        const info = big === 'info' ? bigInfo : { from: ctx.user.id };
        const bytes = big === 'bytes' ? bigBytes : picture;
        const kofi = refs.get('u_kofi')!;
        attempt(() => ctx.channel.binary.send('screen-frame', info, bytes));

        attempt(() => ctx.connections.get(kofi).binary.send('avatar-preview', info, bytes));
        attempt(() => ctx.user.binary.broadcast('avatar-preview', info, bytes));
        attempt(() => ctx.users.get('u_amara').binary.broadcast('avatar-preview', info, bytes));
        attempt(() => ctx.channel.binary.broadcastTo(kofi, 'screen-frame', info, bytes));
        attempt(() => ctx.binary.broadcast('avatar-preview', info, bytes, { includeSelf: true }));

        attempt(() =>
          ctx.channel.binary.broadcast('screen-frame', info, bytes, { includeSelf: true }),
        );
        ctx.tags.ephemeral('team').add('design');
        attempt(() => ctx.tags.ephemeral('team').binary.broadcast('avatar-preview', info, bytes));
      },
    });

    return base.assemble({ handlers: [handleSendTooBig, rooms] });
  }

  async function sendTooBig(big: 'info' | 'bytes') {
    const results: unknown[] = [];
    const { engine, logged } = build(limited(results), { receiveBytes: 100_000, sendBytes: 1000 });
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');
    await amara.send('__subscribe__', {}, general);

    await kofi.send('__subscribe__', {}, general);

    await kofi.send('send-too-big', { big }, general);

    return { results, logged, amara, kofi };
  }

  it('over 64 KiB of info: the sends and the counted broadcasts throw, the others log once each and send nothing', async () => {
    const { results, logged, amara, kofi } = await sendTooBig('info');

    expect(results.slice(0, 5)).toEqual(Array(5).fill(expect.stringMatching(/^throws: .*64 KiB/)));
    expect(results.slice(5)).toEqual([undefined, undefined, undefined]);
    expect(logged).toHaveLength(3);
    expect(amara.binaryFrames()).toEqual([]);
    expect(kofi.binaryFrames()).toEqual([]);
  });

  it('over the message limit: the sends throw, the broadcasts log for each socket and send to none', async () => {
    const { results, logged, amara, kofi } = await sendTooBig('bytes');

    expect(results.slice(0, 2)).toEqual(
      Array(2).fill(expect.stringMatching(/^throws: .*over the send limit of 1000 bytes/)),
    );
    expect(results.slice(2, 5)).toEqual([0, 0, 0]);
    expect(results.slice(5)).toEqual([undefined, undefined, undefined]);
    // One socket each for the user, users.get and broadcastTo; two for each broadcast; one for the tag.
    expect(logged).toHaveLength(8);
    expect(amara.binaryFrames()).toEqual([]);
    expect(kofi.binaryFrames()).toEqual([]);
  });
});

describe('a binary send to a connection that is gone', () => {
  it('returns false from ctx.connections.get(ref).binary.send', async () => {
    const results: unknown[] = [];
    let kofiRef: ConnectionRef | undefined;
    const base = server({
      capabilities: [binary({ emits: { 'avatar-preview': t<null>() } })],
      onConnect(ctx) {
        if (ctx.connection.userId === 'u_kofi') kofiRef = ctx.connection;
      },
    });
    const preview = base.on('preview-avatar', {
      run(ctx) {
        results.push(ctx.connections.get(kofiRef!).binary.send('avatar-preview', null, picture));
      },
    });
    const { engine } = build(base.assemble({ handlers: [preview] }));

    const amara = await connect(engine, 'u_amara');
    const kofi = engine.accept(Symbol('u_kofi'), {
      send: () => {},
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'u_kofi',
    });
    await [...engine.core.connections.values()].at(-1)!.lifecycleReady;
    await kofi.handleClose(1000, 'bye');

    await amara.send('preview-avatar');

    expect(results).toEqual([false]);
  });
});
