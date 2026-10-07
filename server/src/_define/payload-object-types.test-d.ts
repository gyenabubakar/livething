import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { recordedStream, stream } from '~/streams.ts';
import { expectTypeOf } from 'vitest';
import type { TypeMarker } from '~/_api/definitions.ts';

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

const base = server({ capabilities: [stream(), recordedStream(), clientRequests()] });

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
base.recordedStream('progress', {
  maxChunks: 10,
  async *run() {
    yield 1;
  },
});

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
