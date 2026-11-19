/**
 * Compile-time fixtures for awareness: `awareness()` in a channel's `capabilities` plus the
 * channel's `awareness` option. They cover the state schema rules, the typed `check` ctx,
 * the typed `ctx.channel.awareness`, no `set` in the awareness `check`, nothing in the
 * subscribe gates, and the state type in the client contract.
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { awareness } from '~/awareness/capability.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox } from '~/inbox/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type { AwarenessEntry } from '~/context.ts';
import type { InferClient } from '~/infer-client.ts';

type Meta = { name: string; role: 'member' | 'guest' };
type Viewing = { viewingMessageId: string | null };

const base = server({
  authenticate: () => ({ userId: 'u1', meta: { name: 'Ada', role: 'member' } as Meta }),
  capabilities: [channels(), clientRequests(), sequence({ persist: true }), dedup()],
});

const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [awareness(), emits({ 'viewer.refused': t<{ reason: string }>() })],
  awareness: {
    state: v.object({ viewingMessageId: v.nullable(v.string()) }),
    check(ctx, state, previous) {
      expectTypeOf(state).toEqualTypeOf<Viewing>();
      expectTypeOf(previous).toEqualTypeOf<Viewing | null>();
      expectTypeOf(ctx.meta).toEqualTypeOf<Meta>();
      expectTypeOf(ctx.channel.awareness.list()).toEqualTypeOf<AwarenessEntry<Viewing, Meta>[]>();
      // @ts-expect-error — a `set()` here would be overwritten by the update being checked.
      void ctx.channel.awareness.set;
      expectTypeOf(ctx.channel.params).toEqualTypeOf<{ roomId: string }>();
      // @ts-expect-error — the pattern has no `{nope}` param.
      void ctx.channel.params.nope;
      ctx.channel.send('viewer.refused', { reason: 'guest' });
      // @ts-expect-error — the channel has no such event.
      ctx.channel.send('no.such.event', { reason: 'guest' });
      // @ts-expect-error — the payload must match the event.
      ctx.channel.broadcast('viewer.refused', { reason: 1 });

      return ctx.meta.role !== 'guest';
    },
  },
  check(ctx) {
    // @ts-expect-error — the subscribe gates run before the member has any state.
    void ctx.channel.awareness;
    expectTypeOf(ctx.channel.params.roomId).toEqualTypeOf<string>();
  },
  onSubscribe(ctx) {
    expectTypeOf(ctx.channel.awareness.get('c1')).toEqualTypeOf<AwarenessEntry<
      Viewing,
      Meta
    > | null>();
  },
});

export const handleListViewers = rooms.request('list-viewers', {
  run(ctx) {
    ctx.channel.awareness.set('c1', { viewingMessageId: 'm1' });
    ctx.channel.awareness.set('c1', null);
    // @ts-expect-error — the state must match the schema.
    ctx.channel.awareness.set('c1', { viewingMessageId: 5 });
    return { viewers: ctx.channel.awareness.list().map((entry) => entry.meta.name) };
  },
});

const lobby = base.channel('lobby', {});
export const handleLobby = lobby.on('wave', {
  run(ctx) {
    // @ts-expect-error — a channel without awareness() has no awareness.
    void ctx.channel.awareness;
  },
});

// A static channel's `check` gets the whole channel handle, with `{}` params.
base.channel('stage', {
  capabilities: [awareness()],
  awareness: {
    state: v.object({ speaking: v.boolean() }),
    check(ctx, state) {
      expectTypeOf(ctx.channel.params).toEqualTypeOf<{}>();
      expectTypeOf(ctx.channel.name).toEqualTypeOf<string>();
      expectTypeOf(ctx.channel.memberCount()).toEqualTypeOf<number>();
      expectTypeOf(ctx.channel.awareness.list()[0]!.state).toEqualTypeOf<{ speaking: boolean }>();

      return ctx.channel.memberCount() > 0 || state.speaking;
    },
  },
});

// The options can live in a variable. Like any hook written outside the channel, its
// `check` ctx is then not typed by the channel.
const stageOptions = { state: v.object({ speaking: v.boolean() }) };
base.channel('stage-2', { capabilities: [awareness()], awareness: stageOptions });

// Next to other channel-only capabilities.
const feed = base.channel('feed', {
  membership: 'persistent',
  capabilities: [inbox(), awareness()],
  awareness: { state: v.object({ typing: v.boolean() }) },
});
export const handleFeedPing = feed.on('ping', {
  run(ctx) {
    expectTypeOf(ctx.channel.awareness.list()[0]!.state).toEqualTypeOf<{ typing: boolean }>();
    void ctx.channel.inbox;
  },
});

// zod works the same way.
base.channel('zod-room', {
  capabilities: [awareness()],
  awareness: { state: z.object({ x: z.number() }) },
});

// @ts-expect-error — a state must be an object.
base.channel('bad-1', { capabilities: [awareness()], awareness: { state: v.string() } });

// @ts-expect-error — no functions.
base.channel('bad-fn', { capabilities: [awareness()], awareness: { state: v.function() } });

// @ts-expect-error — no arrays.
base.channel('bad-2', { capabilities: [awareness()], awareness: { state: v.array(v.string()) } });

// @ts-expect-error — the schema must not change the type: a default makes the input optional.
base.channel('bad-3', {
  capabilities: [awareness()],
  awareness: { state: v.object({ x: v.optional(v.string(), 'a') }) },
});

// @ts-expect-error — an `any` input hides a change of type.
base.channel('bad-any-input', {
  capabilities: [awareness()],
  awareness: {
    state: v.pipe(
      v.any(),
      v.transform(() => ({ viewingMessageId: null })),
    ),
  },
});

// @ts-expect-error — `check` must return a boolean, not a promise.
base.channel('bad-4', {
  capabilities: [awareness()],
  awareness: { state: v.object({}), check: async () => true },
});

// @ts-expect-error — awareness() takes no options: they go in the channel's `awareness`.
awareness({ state: v.object({}) });

// @ts-expect-error — the `awareness` option needs awareness() in `capabilities`.
base.channel('no-capability', { awareness: { state: v.object({}) } });

// @ts-expect-error — awareness() needs the `awareness` option.
base.channel('no-option', { capabilities: [awareness()] });

server({
  capabilities: [
    channels(),
    // @ts-expect-error — channel-only: it goes in a channel's own `capabilities`.
    awareness(),
  ],
});

// @ts-expect-error — one awareness() per channel.
base.channel('twice', {
  capabilities: [awareness(), awareness()],
  awareness: { state: v.object({}) },
});

// A nested `Date` passes the schema check, but it travels as JSON: the client sees a string.
const drafts = base.channel('drafts', {
  capabilities: [awareness()],
  awareness: { state: v.object({ typingSince: v.date() }) },
});
export const handleDraftPing = drafts.on('ping', { run() {} });

const definition = base.assemble({
  handlers: [handleListViewers, handleLobby, handleFeedPing, handleDraftPing],
});
type Client = InferClient<typeof definition>;

expectTypeOf<Client['channels']['rooms']['awareness']>().toEqualTypeOf<Viewing>();
expectTypeOf<Client['channels']['lobby']>().not.toHaveProperty('awareness');
expectTypeOf<Client['channels']['feed']['awareness']>().toEqualTypeOf<{ typing: boolean }>();
expectTypeOf<Client['channels']['drafts']['awareness']>().toEqualTypeOf<{ typingSince: string }>();
