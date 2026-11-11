import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { recordedStream, stream } from '~/streams.ts';
import { expectTypeOf } from 'vitest';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { InferClient } from '~/infer-client.ts';
import type { ContractPayload, DurableWireChunk } from '~/types.ts';

// `t()` itself takes any type. The places that send a payload refuse what LiveThing refuses
// at runtime: a primitive, an array, a function and an object with toJSON. `null` means no payload.
expectTypeOf(t<null>()).toEqualTypeOf<TypeMarker<null>>();

class Room {
  name = 'general';
}

// An ORM record whose toJSON() gives an object is fine: JSON keeps it an object.
interface MemberRecord {
  id: string;
  toJSON(): { id: string; joinedAt: string };
}

emits({ joined: t<MemberRecord>() });
expectTypeOf<DurableWireChunk<MemberRecord>>().toEqualTypeOf<{ id: string; joinedAt: string }>();

// toJSON() must return a plain object, not an array or a function.
interface TagList {
  toJSON(): string[];
}

interface LazyRecord {
  toJSON(): () => void;
}

// @ts-expect-error JSON would send an array
emits({ tags: t<TagList>() });
// @ts-expect-error JSON would send nothing
emits({ lazy: t<LazyRecord>() });

// An iterable is refused (a Map or a Set becomes {} in JSON), unless its toJSON() returns a
// plain object, which is what JSON sends.
class Roster {
  names = ['ada'];
  *[Symbol.iterator]() {
    yield* this.names;
  }
}

class RosterRecord extends Roster {
  toJSON() {
    return { names: this.names };
  }
}

// @ts-expect-error an iterable without toJSON()
emits({ roster: t<Roster>() });
// @ts-expect-error a Map becomes {} in JSON
emits({ scores: t<Map<string, number>>() });
emits({ roster: t<RosterRecord>() });

emits({ message: t<{ text: string }>(), room: t<Room>(), cleared: t<{}>(), ping: t<null>() });
// @ts-expect-error an event payload must be a plain object or null
emits({ nothing: t<undefined>() });
// @ts-expect-error an event payload must be a plain object
emits({ word: t<string>() });
// @ts-expect-error an event payload must be a plain object
emits({ list: t<string[]>() });
// @ts-expect-error a function is not a payload
emits({ callback: t<() => void>() });
// @ts-expect-error JSON turns a Date into a string
emits({ at: t<Date>() });

serverRequests({ confirm: { out: t<{ question: string }>() }, leave: { out: t<null>() } });
// @ts-expect-error a server request payload must be a plain object
serverRequests({ confirm: { out: t<boolean>() } });

const base = server({
  capabilities: [
    stream(),
    recordedStream(),
    clientRequests(),
    emits({ cleared: t<{}>(), 'notifications-cleared': t<null>() }),
    serverRequests({ refresh: { out: t<{}>() }, 'confirm-leave': { out: t<null>() } }),
  ],
});

// `t<object>()` keeps meaning any object; only `{}` becomes the empty object.
expectTypeOf<ContractPayload<object>>().toEqualTypeOf<object>();
expectTypeOf<ContractPayload<{}>>().toEqualTypeOf<Record<string, never>>();
expectTypeOf<ContractPayload<{ id?: string }>>().toEqualTypeOf<{ id?: string }>();

// `t<{}>()` means an empty object where a payload is sent, not "anything but null".
base.on('clear', {
  run(ctx) {
    ctx.send('cleared', {});
    // @ts-expect-error a string is not an empty object
    ctx.send('cleared', 'text');
    void ctx.request('refresh', {});
    // @ts-expect-error a number is not an empty object
    void ctx.request('refresh', 42);
    // @ts-expect-error null is not an empty object
    ctx.send('cleared', null);
    ctx.send('notifications-cleared', null);
    // @ts-expect-error an empty object is not null
    ctx.send('notifications-cleared', {});
    void ctx.request('confirm-leave', null);
  },
});

base.stream('typing', {
  async *run() {
    yield { userId: 'u1' };
  },
});
base.stream('typing-null', {
  async *run() {
    yield null;
  },
});
base.stream('typing-word', {
  // @ts-expect-error a plain stream chunk must be a plain object or null
  async *run() {
    yield 'typing';
  },
});
// A recorded stream wraps a primitive chunk as `{ value }`, so it may yield one.
const progress = base.recordedStream('progress', {
  maxChunks: 10,
  async *run(): AsyncGenerator<number> {
    yield 1;
  },
});
const mixed = base.recordedStream('mixed', {
  maxChunks: 10,
  async *run(): AsyncGenerator<{ text: string } | string[] | null> {
    yield { text: 'hi' };
  },
});
const durableDefinition = base.assemble({ handlers: [progress, mixed] });
type DurableClient = InferClient<typeof durableDefinition>;

// The client sees what the wire carries: the object as it is, anything else inside `{ value }`.
expectTypeOf<DurableClient['streams']['progress']['chunk']>().toEqualTypeOf<{
  value: number | null;
}>();
expectTypeOf<DurableClient['streams']['mixed']['chunk']>().toEqualTypeOf<
  { text: string } | { value: string[] } | { value: null }
>();
// Decided on the chunk's JSON: a Date arrives as its string.
expectTypeOf<DurableWireChunk<Date>>().toEqualTypeOf<{ value: string }>();
expectTypeOf<DurableWireChunk<Room>>().toEqualTypeOf<Room>();
// The runtime refuses a chunk with no JSON and an iterable without toJSON(), so they are never.
expectTypeOf<DurableWireChunk<() => void>>().toEqualTypeOf<never>();
expectTypeOf<DurableWireChunk<undefined>>().toEqualTypeOf<never>();
expectTypeOf<DurableWireChunk<Map<string, number>>>().toEqualTypeOf<never>();
expectTypeOf<DurableWireChunk<symbol>>().toEqualTypeOf<never>();
expectTypeOf<DurableWireChunk<bigint>>().toEqualTypeOf<never>();
expectTypeOf<DurableWireChunk<{ toJSON(): void }>>().toEqualTypeOf<never>();
// JSON turns NaN and Infinity into null.
expectTypeOf<DurableWireChunk<number | undefined>>().toEqualTypeOf<{ value: number | null }>();
// oxlint-disable-next-line typescript/no-wrapper-object-types -- the boxed type is what is tested
expectTypeOf<DurableWireChunk<Number>>().toEqualTypeOf<{ value: number | null }>();
expectTypeOf<DurableWireChunk<boolean>>().toEqualTypeOf<{ value: boolean }>();
expectTypeOf<DurableWireChunk<BoxedBoolean>>().toEqualTypeOf<{ value: boolean }>();
expectTypeOf<DurableWireChunk<{ total: number }>>().toEqualTypeOf<{ total: number }>();

// PayloadObject refuses a boxed Number or String, and a function even with toJSON().
interface CallableRecord {
  (): void;
  toJSON(): { id: number };
}

// oxlint-disable-next-line typescript/no-wrapper-object-types -- the boxed type is what is tested
type BoxedNumber = Number;
// oxlint-disable-next-line typescript/no-wrapper-object-types -- the boxed type is what is tested
type BoxedString = String;
// oxlint-disable-next-line typescript/no-wrapper-object-types -- the boxed type is what is tested
type BoxedBoolean = Boolean;
// @ts-expect-error JSON unboxes it to 7
emits({ count: t<BoxedNumber>() });
// @ts-expect-error JSON unboxes it to a string
emits({ label: t<BoxedString>() });
// @ts-expect-error JSON unboxes it to true
emits({ flag: t<BoxedBoolean>() });
// A class may have its own valueOf(); JSON ignores it.
emits({ price: t<{ cents: number; valueOf(): number }>() });
// Data fields named like a boxed value's methods are plain data.
emits({
  quote: t<{ valueOf: string; charAt: number; toFixed: number; toJSON: string }>(),
});
expectTypeOf<DurableWireChunk<{ toFixed: number; charAt: string }>>().toEqualTypeOf<{
  toFixed: number;
  charAt: string;
}>();
// @ts-expect-error a function is not a payload
emits({ callable: t<CallableRecord>() });

base.request('get-room', {
  run: () => ({ name: 'general' }),
});
base.request('ack', {
  run: () => {},
});
base.request('maybe', {
  run: () => null,
});
base.request('count', {
  // @ts-expect-error a reply must be a plain object, null or nothing
  run: () => 0,
});

// The client receives the JSON of a payload, so an event whose payload has a toJSON() is typed
// as that JSON, as a durable stream chunk is. It has no toJSON() method on the client.
const recordBase = server({ capabilities: [emits({ joined: t<MemberRecord>() })] });
const recordDefinition = recordBase.assemble({
  handlers: [recordBase.on('noop', { run() {} })],
});
type RecordClient = InferClient<typeof recordDefinition>;
expectTypeOf<RecordClient['incoming']['joined']>().toEqualTypeOf<{
  id: string;
  joinedAt: string;
}>();

// The client receives a `t<null>()` event and server request as null.
const nullBase = server({
  capabilities: [
    emits({ 'notifications-cleared': t<null>() }),
    serverRequests({ 'confirm-leave': { out: t<null>() } }),
  ],
});
const nullDefinition = nullBase.assemble({ handlers: [nullBase.on('noop', { run() {} })] });
type NullClient = InferClient<typeof nullDefinition>;
expectTypeOf<NullClient['incoming']['notifications-cleared']>().toEqualTypeOf<null>();
expectTypeOf<NullClient['serverRequests']['confirm-leave']['payload']>().toEqualTypeOf<null>();

// A reply of null is a void acknowledgement: the server sends no payload and the client's
// request() resolves with undefined, so the client's type must not promise null.
const nullReply = base.request('null-reply', { run: () => null });
const maybeReply = base.request('maybe-reply', {
  run: (): { ok: true } | null => null,
});
const replyDefinition = base.assemble({ handlers: [nullReply, maybeReply] });
type ReplyClient = InferClient<typeof replyDefinition>;
expectTypeOf<ReplyClient['clientRequests']['null-reply']['response']>().toEqualTypeOf<void>();
expectTypeOf<ReplyClient['clientRequests']['maybe-reply']['response']>().toEqualTypeOf<
  { ok: true } | undefined
>();

// The client gets JSON at every depth: a nested Date is a string, a method is gone, an undefined
// item in an array is null.
const nestedBase = server({
  capabilities: [
    emits({
      posted: t<{
        at: Date;
        tags: (string | undefined)[];
        author: { name: string; greet(): void };
      }>(),
    }),
  ],
});
const nestedDefinition = nestedBase.assemble({
  handlers: [nestedBase.on('noop', { run() {} })],
});
expectTypeOf<InferClient<typeof nestedDefinition>['incoming']['posted']>().toEqualTypeOf<{
  at: string;
  tags: (string | null)[];
  author: { name: string };
}>();

// A scheduled task gets its data back from the stored JSON, so a Date field is a string.
const taskBase = server({ capabilities: [scheduled({ remind: { data: t<{ at: Date }>() } })] });
taskBase.scheduled('remind', {
  run(_ctx, data) {
    expectTypeOf(data).toEqualTypeOf<{ at: string }>();
  },
});

// The runtime refuses an async iterable and an array, even one with a toJSON(), so the types do.
emits({
  // @ts-expect-error an async iterable becomes {} in JSON
  feed: t<{ id: string; [Symbol.asyncIterator](): AsyncIterator<number> }>(),
});
// @ts-expect-error an array is refused, even with a toJSON()
emits({ list: t<string[] & { toJSON(key: string): { items: string[] } }>() });
