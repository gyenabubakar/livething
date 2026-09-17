/* oxlint-disable @typescript-eslint/no-unused-vars */
import { error } from '@wskit/core';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { plugin } from './plugins.ts';

interface PresenceApi {
  announce(): void;
  count(): number;
}

const h = server({
  scope: 'plugin',
  capabilities: [emits({ 'user-online': t<{ id: string }>() })],
});
const heartbeat = h.on('heartbeat', { input: v.object({}), run() {} });

const Presence = plugin('acme:presence', {
  definition: h.assemble({
    handlers: [heartbeat],
    api: (): PresenceApi => ({ announce() {}, count: () => 0 }),
  }),
});

const base = server({ capabilities: [Presence()] });

describe('plugin typing', () => {
  it('accepts a plugin capability in server({ capabilities })', () => {
    expectTypeOf(base.on).toBeFunction();
  });

  it('types ctx.plugin via the explicit api type argument', () => {
    base.on('act', {
      run(ctx) {
        const api = ctx.plugin<PresenceApi>('acme:presence');
        expectTypeOf(api).toEqualTypeOf<PresenceApi>();
        expectTypeOf(api.count()).toEqualTypeOf<number>();
      },
    });
  });

  it('infers ctx.plugin(id) from the listed plugin without an explicit type arg', () => {
    base.on('act', {
      run(ctx) {
        const api = ctx.plugin('acme:presence');
        expectTypeOf(api).toEqualTypeOf<PresenceApi>();
      },
    });
  });

  it('folds a plugin surface into the top-level client maps under __id:: names', () => {
    const ph = server({
      scope: 'plugin',
      capabilities: [
        emits({ 'user-online': t<{ id: string }>() }),
        clientRequests(),
        serverRequests(),
      ],
    });
    const beat = ph.on('heartbeat', { input: v.object({}), run() {} });
    const who = ph.request('who-is-here', {
      input: v.object({}),
      run: () => ({ users: [] as string[] }),
    });
    const P = plugin('acme:presence', {
      definition: ph.assemble({
        handlers: [beat, who],
        api: (): PresenceApi => ({ announce() {}, count: () => 0 }),
      }),
    });
    const app = server({ capabilities: [P()] });

    const definition = app.assemble({ handlers: [] });
    type C = InferClient<typeof definition>;
    expectTypeOf<C['incoming']['__acme:presence::user-online']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<C['outgoing']>().toHaveProperty('__acme:presence::heartbeat');
    expectTypeOf<C['clientRequests']>().toHaveProperty('__acme:presence::who-is-here');
    // The client carries no `plugins` key; the plugin api lives on the server ctx.
    expectTypeOf<C>().not.toHaveProperty('plugins');
  });

  it('folds plugin streams / channels / errors into the top-level client maps under __id:: names', () => {
    const Denied = error('denied', v.object({ why: v.string() }));
    const ph = server({
      scope: 'plugin',
      capabilities: [stream(), channels(), errors([Denied])],
    });
    const ticks = ph.stream('ticks', { input: v.object({}), async *run() {} });
    const room = ph.channel('room', { capabilities: [emits({ msg: t<{ text: string }>() })] });
    room.on('say', { input: v.object({}), run() {} });

    const P = plugin('acme:feed', { definition: ph.assemble({ handlers: [ticks, room] }) });
    const app = server({ capabilities: [P()] });
    const feedDefinition = app.assemble({ handlers: [] });
    type C = InferClient<typeof feedDefinition>;
    expectTypeOf<C['streams']>().toHaveProperty('__acme:feed::ticks');

    expectTypeOf<C['channels']>().toHaveProperty('__acme:feed::room');
    expectTypeOf<C['errors']>().toHaveProperty('__acme:feed::denied');
  });

  it('types a plugin upgrade meta through the scoped server generic', () => {
    server<{ userId: string }>({
      scope: 'plugin',
      upgrade() {
        return { userId: 'u1', meta: { userId: 'u1' } };
      },
    });
  });

  it('lets a scoped server definition use the same builders as an app', () => {
    expectTypeOf(h.on).toBeFunction();
    expectTypeOf(h.assemble).toBeFunction();
  });

  it('rejects a host-owned capability inside a scoped server at compile time', () => {
    // @ts-expect-error keepalive() is host-owned and cannot be listed in a plugin
    server({
      scope: 'plugin',
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
  });
});
