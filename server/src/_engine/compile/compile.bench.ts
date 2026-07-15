/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Micro-benchmark for `compileHandlerDefinition` across the same three
 * server shapes the CF e2e harness uses (tiny / medium / heavy). Runs in
 * Node with sub-µs `performance.now` resolution so we can actually see where
 * compile time goes — workerd quantizes `performance.now()` to 1ms so the
 * e2e numbers all look like 0µs.
 *
 * Run: `pnpm --filter @wskit/server bench`
 */

import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { persistence } from '~/persistence/capability.ts';
import { replay } from '~/replay/capability.ts';
import { requests } from '~/request/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import { compileHandlerDefinition } from './compile.ts';

const Empty = v.object({});
const Text = v.object({ text: v.string() });
const NumChunk = t<{ n: number }>();

const EmptyOut = t<Record<string, never>>();
const TextOut = t<{ text: string }>();

const tinyBase = define({
  env: t<Record<string, unknown>>(),
  capabilities: [emits({ notify: EmptyOut })],
});
const tinyHandler = tinyBase.assemble({
  handlers: [tinyBase.on('noop', { input: Empty, run() {} })],
});

const mediumBase = define({
  env: t<Record<string, unknown>>(),
  hibernation: { enabled: true },
  capabilities: [
    persistence(),
    requests(),
    stream(),
    channels(),
    emits({ notify: EmptyOut, joined: EmptyOut }),
  ],
});
const lobby = mediumBase.channel('lobby', { outgoing: { emits: { said: TextOut } } });
lobby.on('say', { input: Text, run() {} });
const rooms = mediumBase.channel(['rooms', 'room:{id}'], {
  outgoing: { emits: { posted: TextOut } },
});
rooms.on('post', { input: Text, run() {} });
const mediumHandler = mediumBase.assemble({
  handlers: [
    mediumBase.on('join', { input: Empty, run() {} }),
    mediumBase.on('leave', { input: Empty, run() {} }),
    mediumBase.on('noop', { input: Empty, run() {} }),
    mediumBase.request('whoami', {
      input: Empty,
      run(ctx) {
        return { id: ctx.identity };
      },
    }),
    mediumBase.stream('tail', {
      input: Empty,
      chunk: NumChunk,
      async *run() {
        yield { n: 1 };
      },
    }),
    lobby,
    rooms,
  ],
});

function channelEmits(prefix: string) {
  return {
    [`${prefix}-message`]: TextOut,
    [`${prefix}-edited`]: TextOut,
  };
}

const heavyBase = define({
  env: t<Record<string, unknown>>(),
  hibernation: { enabled: true },
  capabilities: [
    persistence(),
    dedup(),
    sequence({ persist: true }),
    replay.history(),
    requests(),
    stream(),
    resumableStream(),
    recordedStream(),
    channels(),
    emits({ 'o-a': EmptyOut, 'o-b': EmptyOut, 'o-c': EmptyOut, 'o-d': EmptyOut, 'o-e': EmptyOut }),
  ],
});

const heavyHandlers: any[] = [];
for (const name of ['a', 'b', 'c', 'd', 'e']) {
  heavyHandlers.push(heavyBase.on(name, { input: Empty, run() {} }));
}
for (const name of ['r-a', 'r-b', 'r-c']) {
  heavyHandlers.push(
    heavyBase.request(name, {
      input: Empty,
      run() {
        return {};
      },
    }),
  );
}
for (const name of ['s-a', 's-b']) {
  heavyHandlers.push(
    heavyBase.stream(name, {
      input: Empty,
      chunk: NumChunk,
      async *run() {
        yield { n: 1 };
      },
    }),
  );
}
heavyHandlers.push(
  heavyBase.resumableStream('rs-a', {
    input: Empty,
    chunk: NumChunk,
    async *run() {
      yield { n: 1 };
    },
  }),
);
heavyHandlers.push(
  heavyBase.recordedStream('rec-a', {
    input: Empty,
    chunk: NumChunk,
    async *run() {
      yield { n: 1 };
    },
  }),
);
for (const n of [1, 2, 3, 4, 5]) {
  const ch = heavyBase.channel(`chan-${n}`, { outgoing: { emits: channelEmits(`c${n}`) } });
  ch.on(`c${n}-send`, { input: Text, run() {} });
  ch.on(`c${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}
for (const n of [1, 2, 3, 4, 5]) {
  const ch = heavyBase.channel([`rooms-${n}`, `r${n}:{id}`], {
    outgoing: { emits: channelEmits(`r${n}`) },
  });
  ch.on(`r${n}-send`, { input: Text, run() {} });
  ch.on(`r${n}-edit`, { input: Text, run() {} });
  heavyHandlers.push(ch);
}
const heavyHandler = heavyBase.assemble({ handlers: [...heavyHandlers] });

describe('compileHandlerDefinition', () => {
  bench('tiny  (1 incoming, 1 outgoing)', () => {
    compileHandlerDefinition(tinyHandler);
  });

  bench('medium (~10 events, 2 channels)', () => {
    compileHandlerDefinition(mediumHandler);
  });

  bench('heavy (~50 events, 10 channels)', () => {
    compileHandlerDefinition(heavyHandler);
  });
});
