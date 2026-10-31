import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';
import { expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

it('ctx.user.request reaches both sockets of one user and resolves with the first answer', async () => {
  const results: { ok: boolean; from: string }[] = [];
  const base = server({
    capabilities: [
      serverRequests({
        'confirm-delete': { out: t<{ text: string }>(), in: v.object({ ok: v.boolean() }) },
      }),
    ],
  });
  const askUser = base.on('ask-user', {
    run(ctx) {
      void ctx.user.request('confirm-delete', { text: 'sure?' }).then(({ response, from }) => {
        results.push({ ok: response.ok, from: from.id });
      });
    },
  });

  let captured: Engine | undefined;
  adapter({
    id: 'user-request-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(base.assemble({ handlers: [askUser] }), undefined as never);
  const engine = captured!;
  await engine.initialize();

  async function open() {
    const frames: unknown[][] = [];
    const before = new Set(engine.core.connections.keys());
    const handle = engine.accept(Symbol('ada'), {
      send: (data: string) => {
        frames.push(JSON.parse(data) as unknown[]);
      },
      close() {},
      bufferedAmount: () => 0,
      userId: 'ada',
    });
    const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
    await connection.lifecycleReady;

    return { id: connection.id, handle, frames };
  }

  const laptop = await open();
  const phone = await open();

  await laptop.handle.handleMessage(JSON.stringify(['ask-user', {}, null]));

  const toLaptop = laptop.frames.find((frame) => frame[0] === 'confirm-delete')!;
  const toPhone = phone.frames.find((frame) => frame[0] === 'confirm-delete')!;
  expect(toLaptop[1]).toEqual({ text: 'sure?' });
  expect(toPhone[1]).toEqual({ text: 'sure?' });

  const laptopExchange = (toLaptop[2] as { exchange: { id: string } }).exchange;
  const phoneExchange = (toPhone[2] as { exchange: { id: string } }).exchange;
  expect(laptopExchange.id).not.toBe(phoneExchange.id);

  await phone.handle.handleMessage(
    JSON.stringify(['confirm-delete', { ok: true }, { exchange: phoneExchange }]),
  );
  await laptop.handle.handleMessage(
    JSON.stringify(['confirm-delete', { ok: false }, { exchange: laptopExchange }]),
  );
  await Promise.resolve();

  expect(results).toEqual([{ ok: true, from: phone.id }]);
});
