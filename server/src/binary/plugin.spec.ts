import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const picture = new Uint8Array([137, 80, 78, 71]);
const stage = { channel: { name: '__acme:screens::stage' } };

function screensPlugin(seen: number[][]) {
  const screens = server({
    scope: 'plugin',
    capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } }), channels()],
  });
  const stageChannel = screens.channel('stage', {
    capabilities: [binary({ emits: { 'stage-frame': t<null>() } })],
  });
  const handleShareScreenFrame = screens.binary.on('share-screen-frame', {
    run(ctx, _input, bytes) {
      seen.push([...bytes]);
      ctx.binary.send('screen-frame', { from: ctx.user.id }, bytes);
    },
  });
  const handleShareStageFrame = stageChannel.binary.on('share-stage-frame', {
    run(ctx, _input, bytes) {
      ctx.channel.binary.broadcast('stage-frame', null, bytes, { includeSelf: true });
    },
  });

  return plugin('acme:screens', {
    definition: screens.assemble({
      handlers: [handleShareScreenFrame, stageChannel, handleShareStageFrame],
    }),
  });
}

function start(definition: ServerDefinition): Engine {
  let engine!: Engine;
  adapter({
    id: 'binary-plugin-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, undefined as never);
  return engine;
}

async function connect(engine: Engine) {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol('u_amara'), {
    send: (data: TransportFrame) => sent.push(data),
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'u_amara',
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  return {
    handle,
    envelopes: () =>
      sent.flatMap((data) => {
        if (data.kind !== 'bytes') return [];

        const split = splitBinaryFrame(data.bytes);
        return split.kind === 'frame' ? [JSON.parse(split.envelope) as unknown[]] : [];
      }),
  };
}

describe('a plugin that lists binary()', () => {
  it('counts its __<id>:: prefix in the 128 characters of a binary name', () => {
    // '__acme:screens::' is 16 characters, so 112 is the longest name.
    function screensWith(name: string) {
      const screens = server({ scope: 'plugin', capabilities: [binary()] });
      const handleShare = screens.binary.on(name, { run() {} });
      const Screens = plugin('acme:screens', {
        definition: screens.assemble({ handlers: [handleShare] }),
      });
      return server({ capabilities: [Screens()] }).assemble({ handlers: [] });
    }

    expect(() => start(screensWith('a'.repeat(112)))).not.toThrow();
    expect(() => start(screensWith('a'.repeat(113)))).toThrow(/128/);
  });

  it('takes its binary events under its __<id>:: prefix, and sends them back prefixed', async () => {
    const seen: number[][] = [];
    const Screens = screensPlugin(seen);
    const engine = start(server({ capabilities: [Screens()] }).assemble({ handlers: [] }));
    const { handle, envelopes } = await connect(engine);

    await handle.handleBinaryMessage(
      encodeBinaryFrame('["share-screen-frame",null,null]', picture),
    );
    await handle.handleBinaryMessage(
      encodeBinaryFrame('["__acme:screens::share-screen-frame",null,null]', picture),
    );

    expect(seen).toEqual([[...picture]]);
    expect(envelopes()).toEqual([['__acme:screens::screen-frame', { from: 'u_amara' }, null]]);
  });

  it('broadcasts binary events in its own channel, under its prefix', async () => {
    const Screens = screensPlugin([]);
    const engine = start(server({ capabilities: [Screens()] }).assemble({ handlers: [] }));
    const { handle, envelopes } = await connect(engine);
    await handle.handleMessage(JSON.stringify(['__subscribe__', {}, stage]));

    await handle.handleBinaryMessage(
      encodeBinaryFrame(
        JSON.stringify(['__acme:screens::share-stage-frame', null, stage]),
        picture,
      ),
    );

    expect(envelopes().map((envelope) => envelope[0])).toEqual(['__acme:screens::stage-frame']);
  });

  it('runs its binary requests, streams and server requests under its prefix', async () => {
    const answers: unknown[] = [];
    const files = server({
      scope: 'plugin',
      capabilities: [
        binary({ serverRequests: { 'capture-screen': { out: t<null>(), in: v.null() } } }),
        clientRequests(),
        serverRequests(),
        stream(),
      ],
    });
    const handleGetFile = files.binary.request('get-file', {
      run: (_ctx, _input, bytes) => ({ info: { size: bytes.byteLength }, bytes }),
    });
    const handleDownloadFile = files.binary.stream('download-file', {
      async *run(_ctx, _input, bytes) {
        yield { info: { size: bytes.byteLength }, bytes };
      },
    });
    const handleShareScreen = files.on('share-screen', {
      async run(ctx) {
        answers.push(await ctx.binary.request('capture-screen', null));
      },
    });

    const Files = plugin('acme:files', {
      definition: files.assemble({
        handlers: [handleGetFile, handleDownloadFile, handleShareScreen],
      }),
    });
    const engine = start(server({ capabilities: [Files()] }).assemble({ handlers: [] }));
    const { handle, envelopes } = await connect(engine);

    await handle.handleBinaryMessage(
      encodeBinaryFrame(
        JSON.stringify([
          '__acme:files::get-file',
          null,
          { exchange: { id: 'r-1', source: 'client' } },
        ]),
        picture,
      ),
    );
    await handle.handleBinaryMessage(
      encodeBinaryFrame(
        JSON.stringify(['__acme:files::download-file', null, { stream: { id: 's-1' } }]),
        picture,
      ),
    );
    void handle.handleMessage(JSON.stringify(['__acme:files::share-screen', null, null]));
    await new Promise((resolve) => setImmediate(resolve));
    const request = envelopes().at(-1)!;

    await handle.handleBinaryMessage(
      encodeBinaryFrame(
        JSON.stringify(['__acme:files::capture-screen', null, request[2]]),
        picture,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(envelopes()).toEqual([
      ['__acme:files::get-file', { size: 4 }, { exchange: { id: 'r-1', source: 'client' } }],
      [
        '__acme:files::download-file',
        { size: 4 },
        { stream: { id: 's-1', durability: 'ephemeral', seq: 1 } },
      ],
      [
        '__acme:files::capture-screen',
        null,
        { exchange: { id: expect.any(String), source: 'server' } },
      ],
    ]);
    expect(answers).toEqual([{ info: null, bytes: picture }]);
  });
});
