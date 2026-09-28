/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: `ctx.broadcastRequest` and `ctx.channel.broadcastRequest`
 * run for one current connection, so they accept `includeSelf`. Handles that
 * have no current connection (`ctx.channels.get(...)`, tag handles) do not.
 */
import { t } from '~/_api/index.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { ConnectionRef } from '~/context.ts';

const base = server({
  capabilities: [
    serverRequests({ vote: { out: t<{ topic: string }>(), in: v.object({ yes: v.boolean() }) } }),
    channels(),
    tags((ephemeral) => [ephemeral('role', t<string>())]),
  ],
});

const room = base.channel('room', {
  capabilities: [serverRequests({ ready: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } })],
});

base.on('ask', {
  run(ctx) {
    expectTypeOf(
      ctx.broadcastRequest('vote', { topic: 'x' }, { includeSelf: true, timeout: 1_000 }),
    ).toEqualTypeOf<
      Promise<{ readonly response: { yes: boolean }; readonly from: ConnectionRef }>
    >();
    void ctx.broadcastRequest('vote', { topic: 'x' }, { includeSelf: false });

    // @ts-expect-error — includeSelf is a boolean
    void ctx.broadcastRequest('vote', { topic: 'x' }, { includeSelf: 'yes' });

    // @ts-expect-error — a channel handle from ctx.channels.get has no current connection
    void ctx.channels.get(room).broadcastRequest('ready', {}, { includeSelf: true });

    // @ts-expect-error — a tag handle has no current connection
    void ctx.tags.ephemeral('role').broadcastRequest('vote', { topic: 'x' }, { includeSelf: true });
  },
});

room.on('go', {
  run(ctx) {
    expectTypeOf(ctx.channel.broadcastRequest('ready', {}, { includeSelf: true })).toEqualTypeOf<
      Promise<{ readonly response: { ok: boolean }; readonly from: ConnectionRef }>
    >();

    // @ts-expect-error — includeSelf is a boolean
    void ctx.channel.broadcastRequest('ready', {}, { includeSelf: 1 });
  },
});
