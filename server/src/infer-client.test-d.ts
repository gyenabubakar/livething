/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixtures for `InferClient` slots that had no type-test:
 * `serverRequests` (gap 6, top-level and channel-scoped) and the stream `kind`
 * discriminator that marks plain streams ephemeral and durable streams
 * persistent (gap 8).
 */
import { t } from '~/_api/index.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { sequence } from '~/sequence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
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

expectTypeOf<ReqClient['serverRequests']['vol']>().toEqualTypeOf<{
  payload: {};
  response: { r: boolean };
}>();

expectTypeOf<ReqClient['channels']['room']['serverRequests']['confirm-kick']>().toEqualTypeOf<{
  payload: { target: string };
  response: { ok: boolean };
}>();
expectTypeOf<ReqClient['channels']['room']['serverRequests']['vol']>().toEqualTypeOf<{
  payload: {};
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
  capabilities: [emits({ noop: t<{}>() }), stream(), resumableStream(), recordedStream()],
});

const plainStream = streamBase.stream('plain', {
  chunk: t<{ tick: number }>(),
  run: async function* () {},
});

const resumable = streamBase.resumableStream('resume', {
  chunk: t<{ tick: number }>(),
  cursor: t<{ at: number }>(),
  nudges: { faster: v.object({ by: v.number() }) },
  run: async function* () {},
});

const recorded = streamBase.recordedStream('record', {
  chunk: t<{ tick: number }>(),
  run: async function* () {},
});

const streamDef = streamBase.assemble({ handlers: [plainStream, resumable, recorded] });
type StreamClient = InferClient<typeof streamDef>;

// A plain stream is ephemeral and carries no cursor (tidied away).
expectTypeOf<StreamClient['streams']['plain']['kind']>().toEqualTypeOf<'ephemeral'>();
expectTypeOf<StreamClient['streams']['plain']>().not.toHaveProperty('cursor');
expectTypeOf<StreamClient['streams']['plain']>().not.toHaveProperty('nudges');

// A resumable stream is persistent and keeps its declared cursor and nudges.
expectTypeOf<StreamClient['streams']['resume']['kind']>().toEqualTypeOf<'persistent'>();
expectTypeOf<StreamClient['streams']['resume']['cursor']>().toEqualTypeOf<{ at: number }>();
expectTypeOf<StreamClient['streams']['resume']['nudges']>().toHaveProperty('faster');

// A recorded stream is persistent; with no cursor declared, the field is tidied.
expectTypeOf<StreamClient['streams']['record']['kind']>().toEqualTypeOf<'persistent'>();
expectTypeOf<StreamClient['streams']['record']>().not.toHaveProperty('cursor');

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
