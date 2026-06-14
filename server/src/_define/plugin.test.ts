/* oxlint-disable @typescript-eslint/no-unused-vars */
import { error } from '@wskit/core';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { requests } from '~/request/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { plugin } from './plugin.ts';

interface Env {
  SECRET: string;
}

interface PresenceApi {
  announce(): void;
  count(): number;
}

const h = define({
  scoped: true,
  capabilities: [emits({ 'user-online': t<{ id: string }>() })],
});
const heartbeat = h.on('heartbeat', { input: v.object({}), run() {} });

const Presence = plugin('acme:presence', {
  handler: h.assemble(heartbeat),
  api: (): PresenceApi => ({ announce() {}, count: () => 0 }),
});

const base = define({ env: t<Env>(), capabilities: [Presence] });

describe('plugin typing', () => {
  it('accepts a plugin capability in define({ capabilities })', () => {
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

  it('accepts an optional registrationId on ctx.plugin', () => {
    base.on('act', {
      run(ctx) {
        const api = ctx.plugin('acme:presence', 'second');
        expectTypeOf(api).toEqualTypeOf<PresenceApi>();
      },
    });
  });

  it('surfaces the plugin slice under InferClient.plugins[id] with short names', () => {
    const ph = define({
      scoped: true,
      capabilities: [emits({ 'user-online': t<{ id: string }>() }), requests()],
    });
    const beat = ph.on('heartbeat', { input: v.object({}), run() {} });
    const who = ph.request('who-is-here', {
      input: v.object({}),
      run: () => ({ users: [] as string[] }),
    });
    const P = plugin('acme:presence', {
      handler: ph.assemble(beat, who),
      api: (): PresenceApi => ({ announce() {}, count: () => 0 }),
    });
    const app = define({ env: t<Env>(), capabilities: [P] });
    const handler = app.assemble();
    type C = InferClient<typeof handler>;
    type Slice = C['plugins']['acme:presence'];
    expectTypeOf<Slice['incoming']['user-online']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<keyof Slice['outgoing']>().toEqualTypeOf<'heartbeat'>();
    expectTypeOf<keyof Slice['requests']>().toEqualTypeOf<'who-is-here'>();
    expectTypeOf<Slice['api']>().toEqualTypeOf<PresenceApi>();
  });

  it('surfaces plugin streams / channels / errors under the client slice with short names', () => {
    const Denied = error('denied', v.object({ why: v.string() }));
    const ph = define({
      scoped: true,
      capabilities: [stream(), channels(), errors([Denied])],
    });
    const ticks = ph.stream('ticks', { input: v.object({}), async *run() {} });
    const room = ph.channel('room', { outgoing: { emits: { msg: t<{ text: string }>() } } });
    room.on('say', { input: v.object({}), run() {} });
    const P = plugin('acme:feed', { handler: ph.assemble(ticks, room) });
    const app = define({ env: t<Env>(), capabilities: [P] });
    const feedHandler = app.assemble();
    type C = InferClient<typeof feedHandler>;
    type Slice = C['plugins']['acme:feed'];
    expectTypeOf<keyof Slice['streams']>().toEqualTypeOf<'ticks'>();
    expectTypeOf<keyof Slice['channels']>().toEqualTypeOf<'room'>();
    expectTypeOf<keyof Slice['errors']>().toEqualTypeOf<'denied'>();
  });

  it('types a plugin upgrade meta through the scoped define generic', () => {
    define<{ userId: string }>({
      scoped: true,
      upgrade() {
        return { identity: 'u1', meta: { userId: 'u1' } };
      },
    });
  });

  it('lets a scoped handler use the same builders as an app', () => {
    expectTypeOf(h.on).toBeFunction();
    expectTypeOf(h.assemble).toBeFunction();
  });

  it('rejects a host-owned capability inside a scoped define at compile time', () => {
    // @ts-expect-error keepalive() is host-owned and cannot be listed in a plugin
    define({
      scoped: true,
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
  });
});
