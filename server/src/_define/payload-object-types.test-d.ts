import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { cursorStream, recordedStream, stream } from '~/streams.ts';
import { expectTypeOf } from 'vitest';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { InferClient } from '~/infer-client.ts';

// `t()` itself takes any type. The places that send a payload refuse what LiveThing refuses
// at runtime: null, a primitive and an array.
expectTypeOf(t<null>()).toEqualTypeOf<TypeMarker<null>>();

emits({ message: t<{ text: string }>() });
// @ts-expect-error an event payload must be a plain object
emits({ ping: t<null>() });
// @ts-expect-error an event payload must be a plain object
emits({ word: t<string>() });
// @ts-expect-error an event payload must be a plain object
emits({ list: t<string[]>() });

serverRequests({ confirm: { out: t<{ question: string }>() } });
// @ts-expect-error a server request payload must be a plain object
serverRequests({ confirm: { out: t<boolean>() } });

const base = server({
  capabilities: [stream(), recordedStream(), cursorStream(), clientRequests()],
});

base.stream('typing', {
  async *run() {
    yield { userId: 'u1' };
  },
});
base.stream('typing-null', {
  // @ts-expect-error a plain stream chunk must be a plain object
  async *run() {
    yield null;
  },
});
// A recorded stream wraps a primitive chunk as `{ value }`, so it may yield one.
const progress = base.recordedStream('progress', {
  chunk: t<number>(),
  maxChunks: 10,
  async *run() {
    yield 1;
  },
});
const mixed = base.recordedStream('mixed', {
  chunk: t<{ text: string } | string[] | null>(),
  maxChunks: 10,
  async *run() {
    yield { text: 'hi' };
  },
});
const pages = base.cursorStream('pages', {
  chunk: t<number>(),
  cursor: t<{ page: number }>(),
  async *run(ctx) {
    yield ctx.stream.withCursor(1, { page: 1 });
  },
});
const durableDefinition = base.assemble({ handlers: [progress, mixed, pages] });
type DurableClient = InferClient<typeof durableDefinition>;

// The client sees what the wire carries: the object as it is, anything else inside `{ value }`.
expectTypeOf<DurableClient['streams']['progress']['chunk']>().toEqualTypeOf<{ value: number }>();
expectTypeOf<DurableClient['streams']['mixed']['chunk']>().toEqualTypeOf<
  { text: string } | { value: string[] } | { value: null }
>();
expectTypeOf<DurableClient['streams']['pages']['chunk']>().toEqualTypeOf<{ value: number }>();

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
