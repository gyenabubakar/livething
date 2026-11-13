/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixtures for `InferClient` slots that had no type-test:
 * `serverRequests` (gap 6, top-level and channel-scoped) and the stream `kind`
 * discriminator that marks plain streams ephemeral and durable streams
 * persistent (gap 8).
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { InferClient } from '~/infer-client.ts';

// ---------------------------------------------------------------------------
// Gap 6 — `serverRequests` on InferClient (top-level + channel-scoped).
// ---------------------------------------------------------------------------
const reqBase = server({
  capabilities: [
    serverRequests({
      ask: { out: t<{ a: string }>(), in: v.object({ ok: v.boolean() }) },
      vol: { out: t<{}>(), in: v.object({ r: v.boolean() }) },
    }),
    channels(),
  ],
});

const reqChannel = reqBase.channel(['room', 'room:{id}'], {
  capabilities: [
    emits({ tick: t<{ n: number }>() }),
    serverRequests({
      'confirm-kick': { out: t<{ target: string }>(), in: v.object({ ok: v.boolean() }) },
      vol: { out: t<{}>(), in: v.object({ r: v.boolean() }) },
    }),
  ],
});
const reqChannelDefinition = reqChannel.on('ping', { run() {} });

const reqDef = reqBase.assemble({
  handlers: [reqBase.on('noop', { run() {} }), reqChannelDefinition],
});
type ReqClient = InferClient<typeof reqDef>;

expectTypeOf<ReqClient['serverRequests']['ask']>().toEqualTypeOf<{
  payload: { a: string };
  response: { ok: boolean };
}>();

// `t<{}>()` is recorded as an empty object, so a primitive cannot pass as the payload.
expectTypeOf<ReqClient['serverRequests']['vol']>().toEqualTypeOf<{
  payload: Record<string, never>;
  response: { r: boolean };
}>();

expectTypeOf<ReqClient['channels']['room']['serverRequests']['confirm-kick']>().toEqualTypeOf<{
  payload: { target: string };
  response: { ok: boolean };
}>();
expectTypeOf<ReqClient['channels']['room']['serverRequests']['vol']>().toEqualTypeOf<{
  payload: Record<string, never>;
  response: { r: boolean };
}>();

// ---------------------------------------------------------------------------
// A selected channel handler is the exact client contract and runtime surface.
// ---------------------------------------------------------------------------
const selectedBase = server({ capabilities: [channels()] });
const selectedChannel = selectedBase.channel('selected', {});
const selectedDefinition = selectedChannel.on('selected-event', { run() {} });
selectedChannel.on('unselected-event', { run() {} });
const selectedDef = selectedBase.assemble({ handlers: [selectedDefinition] });
type SelectedClient = InferClient<typeof selectedDef>;

expectTypeOf<SelectedClient['channels']['selected']['outgoing']>().toHaveProperty('selected-event');
expectTypeOf<SelectedClient['channels']['selected']['outgoing']>().not.toHaveProperty(
  'unselected-event',
);

// ---------------------------------------------------------------------------
// Gap 8 — stream `kind` discriminator.
// ---------------------------------------------------------------------------
const streamBase = server({
  capabilities: [emits({ noop: t<{}>() }), stream(), recordedStream()],
});

const plainStream = streamBase.stream('plain', {
  run: async function* (): AsyncGenerator<{ tick: number }> {},
});

const recorded = streamBase.recordedStream('record', {
  nudges: { faster: v.object({ by: v.number() }) },
  run: async function* (): AsyncGenerator<{ tick: number }> {},
});

// With no annotation, the chunk type is the union of what `run` yields.
const searchMessages = streamBase.stream('search-messages', {
  async *run() {
    if (Math.random() > 0.5) {
      yield { done: true as const };
      return;
    }

    yield { hit: 'launch plan', score: 0.9 };
  },
});

streamBase.stream('plain', {
  // @ts-expect-error: the chunk type comes from `run`, so there is no `chunk` option
  chunk: t<{ tick: number }>(),
  async *run() {
    yield { tick: 1 };
  },
});

const streamDef = streamBase.assemble({ handlers: [plainStream, recorded, searchMessages] });
type StreamClient = InferClient<typeof streamDef>;

expectTypeOf<StreamClient['streams']['plain']['chunk']>().toEqualTypeOf<{ tick: number }>();
expectTypeOf<StreamClient['streams']['search-messages']['chunk']>().toEqualTypeOf<
  { done: true } | { hit: string; score: number }
>();

// A plain stream is ephemeral, and an empty nudge map is tidied away.
expectTypeOf<StreamClient['streams']['plain']['kind']>().toEqualTypeOf<'ephemeral'>();
expectTypeOf<StreamClient['streams']['plain']>().not.toHaveProperty('nudges');

// A recorded stream is persistent and keeps its nudges.
expectTypeOf<StreamClient['streams']['record']['kind']>().toEqualTypeOf<'persistent'>();
expectTypeOf<StreamClient['streams']['record']['nudges']>().toHaveProperty('faster');

// ---------------------------------------------------------------------------
// Gap — a channel's own `capabilities` (`inbox()` / `readReceipts()`) must
// produce the `inbox: true` / `readReceipts: true` flags InferClient exposes.
// ---------------------------------------------------------------------------
const flagsBase = server({
  capabilities: [channels(), sequence({ persist: true }), dedup()],
});

const flaggedChannel = flagsBase.channel('flagged', {
  capabilities: [inbox(), readReceipts(), emits({ joined: t<{ id: string }>() })],
});
const flaggedChannelDefinition = flaggedChannel.on('join', {
  input: v.object({ id: v.string() }),
  run() {},
});

const plainChannel = flagsBase.channel('plain', {});

// Passing a channel itself includes its configuration. This also includes the
// plain channel, which has no handler value to pass.
const flagsDef = flagsBase.assemble({
  handlers: [flaggedChannel, plainChannel, flaggedChannelDefinition],
});
type FlagsClient = InferClient<typeof flagsDef>;

expectTypeOf<FlagsClient['channels']['flagged']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<FlagsClient['channels']['flagged']['readReceipts']>().toEqualTypeOf<true>();
expectTypeOf<FlagsClient['channels']['flagged']['incoming']['joined']>().toEqualTypeOf<{
  id: string;
}>();
expectTypeOf<FlagsClient['channels']['flagged']['outgoing']['join']>().toEqualTypeOf<{
  id: string;
}>();

expectTypeOf<FlagsClient['channels']['plain']>().not.toHaveProperty('inbox');
expectTypeOf<FlagsClient['channels']['plain']>().not.toHaveProperty('readReceipts');

// A channel's flags travel with its handler values: a definition assembled
// only from channel handlers still gives the client `inbox` / `readReceipts`.
const inboxOnlyChannel = flagsBase.channel('inboxOnly', { capabilities: [inbox()] });
const handleInboxSay = inboxOnlyChannel.on('say', { run() {} });

const receiptsFamily = flagsBase.channel(['receiptsRoom', 'room/:id'], {
  capabilities: [inbox(), readReceipts()],
});
const handleReceiptsSay = receiptsFamily.on('say', { run() {} });

const plainHandlerChannel = flagsBase.channel('plainHandler', {});
const handlePlainSay = plainHandlerChannel.on('say', { run() {} });

const handlerOnlyDef = flagsBase.assemble({
  handlers: [handleInboxSay, handleReceiptsSay, handlePlainSay],
});
type HandlerOnlyClient = InferClient<typeof handlerOnlyDef>;

expectTypeOf<HandlerOnlyClient['channels']['inboxOnly']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<HandlerOnlyClient['channels']['inboxOnly']>().not.toHaveProperty('readReceipts');
expectTypeOf<HandlerOnlyClient['channels']['receiptsRoom']['inbox']>().toEqualTypeOf<true>();
expectTypeOf<HandlerOnlyClient['channels']['receiptsRoom']['readReceipts']>().toEqualTypeOf<true>();
expectTypeOf<HandlerOnlyClient['channels']['plainHandler']>().not.toHaveProperty('inbox');
expectTypeOf<HandlerOnlyClient['channels']['plainHandler']>().not.toHaveProperty('readReceipts');
