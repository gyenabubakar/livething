import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import type { InferClient } from '~/infer-client.ts';
import { channels } from './capability.ts';

const base = define({ env: t<{ SECRET: string }>(), capabilities: [channels()] });

const lobby = base.channel('lobby', {
  outgoing: { emits: { joined: t<{ id: string }>() } },
  subscribe: v.object({ token: v.string() }),
});
const handleChat = lobby.on('chat', { input: v.object({ text: v.string() }), run() {} });

const room = base.channel(['rooms', 'rooms:{id}'], {
  outgoing: { emits: { said: t<{ text: string }>() } },
});
const handleSay = room.on('say', { input: v.object({ text: v.string() }), run() {} });

const handler = base.assemble(handleChat, handleSay);
type C = InferClient<typeof handler>;

describe('channel typing', () => {
  it('flips channel emits to client incoming and channel handlers to client outgoing', () => {
    expectTypeOf<C['channels']['lobby']['incoming']['joined']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<C['channels']['lobby']['outgoing']['chat']>().toEqualTypeOf<{ text: string }>();
  });

  it('carries the subscribe payload and addressing', () => {
    expectTypeOf<C['channels']['lobby']['subscribePayload']>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<C['channels']['lobby']['addressing']>().toEqualTypeOf<'static'>();
    expectTypeOf<C['channels']['rooms']['addressing']>().toEqualTypeOf<'dynamic'>();
  });

  it('types ctx.channel.params from the family pattern', () => {
    base.channel(['orgs', 'org:{orgId}'], {}).on('x', {
      input: v.object({}),
      run(ctx) {
        expectTypeOf(ctx.channel.params).toEqualTypeOf<{ orgId: string }>();
      },
    });
  });

  it('types ctx.channel.broadcast against the channel emits', () => {
    room.on('typed', {
      input: v.object({}),
      run(ctx) {
        ctx.channel.broadcast('said', { text: 'hi' });
        // @ts-expect-error 'said' payload must be { text: string }
        ctx.channel.broadcast('said', { wrong: 1 });
      },
    });
  });
});
