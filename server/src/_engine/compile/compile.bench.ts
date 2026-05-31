/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Micro-benchmark for `compileHandlerDefinition` across the same three
 * contract shapes the CF e2e harness uses (tiny / medium / heavy). Runs in
 * Node with sub-µs `performance.now` resolution so we can actually see where
 * compile time goes — workerd quantizes `performance.now()` to 1ms so the
 * e2e numbers all look like 0µs.
 *
 * Run: `pnpm --filter @wskit/server bench`
 */

import { contract } from '~/_api/contract.ts';
import { t } from '~/_api/definitions.ts';
import { implement } from '~/_api/implement.ts';
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import { outgoing } from '~/outgoing/definition.ts';
import { request } from '~/request/definition.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { bench, describe } from 'vitest';
import { compileHandlerDefinition } from './compile.ts';

const Empty = v.object({});
const Text = v.object({ text: v.string() });
const NumChunk = v.object({ n: v.number() });

// ── Tiny: 1 incoming, 1 outgoing ──
const tinyContract = contract('bench-tiny', {
  env: t<Record<string, unknown>>(),
  definitions: [incoming('noop', Empty), outgoing('ack', Empty)],
});
const tinyHandler = implement(tinyContract)
  .on('noop', () => {})
  .build();

// ── Medium: ~10 events, 2 channels, 1 namespace ──
const mediumContract = contract('bench-medium', {
  env: t<Record<string, unknown>>(),
  persistence: true,
  hibernation: true,
  definitions: [
    incoming('join', Empty),
    incoming('leave', Empty),
    incoming('noop', Empty),
    outgoing('ack', Empty),
    outgoing('joined', Empty),
    request('whoami', { payload: Empty, response: v.object({ id: v.string() }) }),
    stream('tail', { payload: Empty, chunk: NumChunk }),
    channel('lobby', {
      definitions: [incoming('say', Text), outgoing('said', Text)],
    }),
    channel(scope('rooms', 'room:{id}'), {
      definitions: [incoming('post', Text), outgoing('posted', Text)],
    }),
    namespace('admin', {
      definitions: [
        incoming('kick', v.object({ id: v.string() })),
        outgoing('kicked', v.object({ id: v.string() })),
      ],
    }),
  ],
});
const mediumHandler = implement(mediumContract)
  .on('noop', () => {})
  .on('join', () => {})
  .on('leave', () => {})
  .request('whoami', (ctx) => {
    ctx.respond({ id: ctx.identity });
  })
  .stream('tail', async function* () {
    yield { n: 1 };
  })
  .channel('lobby', (ch) => ch.on('say', () => {}))
  .channel('rooms', (ch) => ch.on('post', () => {}))
  .namespace('admin', (ns) => ns.on('kick', () => {}))
  .build();

// ── Heavy: ~50 events, 10 channels, 2 namespaces ──
function channelDefs(prefix: string) {
  return [
    incoming(`${prefix}-send`, Text),
    incoming(`${prefix}-edit`, Text),
    outgoing(`${prefix}-message`, Text),
    outgoing(`${prefix}-edited`, Text),
  ] as const;
}
const heavyContract = contract('bench-heavy', {
  env: t<Record<string, unknown>>(),
  persistence: true,
  hibernation: true,
  replay: true,
  sequence: { persist: true },
  dedup: true,
  definitions: [
    incoming('a', Empty),
    incoming('b', Empty),
    incoming('c', Empty),
    incoming('d', Empty),
    incoming('e', Empty),
    outgoing('o-a', Empty),
    outgoing('o-b', Empty),
    outgoing('o-c', Empty),
    outgoing('o-d', Empty),
    outgoing('o-e', Empty),
    request('r-a', { payload: Empty, response: Empty }),
    request('r-b', { payload: Empty, response: Empty }),
    request('r-c', { payload: Empty, response: Empty }),
    stream('s-a', { payload: Empty, chunk: NumChunk }),
    stream('s-b', { payload: Empty, chunk: NumChunk }),
    resumableStream('rs-a', { payload: Empty, chunk: NumChunk }),
    recordedStream('rec-a', { payload: Empty, chunk: NumChunk }),
    channel('chan-1', { definitions: channelDefs('c1') }),
    channel('chan-2', { definitions: channelDefs('c2') }),
    channel('chan-3', { definitions: channelDefs('c3') }),
    channel('chan-4', { definitions: channelDefs('c4') }),
    channel('chan-5', { definitions: channelDefs('c5') }),
    channel(scope('rooms-1', 'r1:{id}'), { definitions: channelDefs('r1') }),
    channel(scope('rooms-2', 'r2:{id}'), { definitions: channelDefs('r2') }),
    channel(scope('rooms-3', 'r3:{id}'), { definitions: channelDefs('r3') }),
    channel(scope('rooms-4', 'r4:{id}'), { definitions: channelDefs('r4') }),
    channel(scope('rooms-5', 'r5:{id}'), { definitions: channelDefs('r5') }),
    namespace('admin', {
      definitions: [
        incoming('kick', v.object({ id: v.string() })),
        incoming('ban', v.object({ id: v.string() })),
        outgoing('kicked', v.object({ id: v.string() })),
      ],
    }),
    namespace('v1', {
      definitions: [
        incoming('noop', Empty),
        outgoing('ack', Empty),
        request('echo', { payload: Empty, response: Empty }),
      ],
    }),
  ],
});

// Build the heavy implementer programmatically — handlers are no-ops since
// we're measuring compile cost, not runtime cost.
const heavyImpl: any = implement(heavyContract as any);
for (const def of heavyContract.definitions as readonly any[]) {
  if (def._ === 'incoming') heavyImpl.on(def.name, () => {});
  if (def._ === 'request') heavyImpl.request(def.name, (ctx: any) => ctx.respond({}));
  if (def._ === 'stream')
    heavyImpl.stream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'resumable-stream')
    heavyImpl.resumableStream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'recorded-stream')
    heavyImpl.recordedStream(def.name, async function* () {
      yield { n: 1 };
    });
  if (def._ === 'channel') {
    const key = typeof def.pattern === 'string' ? def.pattern : def.pattern.key;
    heavyImpl.channel(key, (ch: any) => {
      for (const child of def.definitions as readonly any[]) {
        if (child._ === 'incoming') ch.on(child.name, () => {});
      }
      return ch;
    });
  }
  if (def._ === 'namespace') {
    heavyImpl.namespace(def.name, (ns: any) => {
      for (const child of def.definitions as readonly any[]) {
        if (child._ === 'incoming') ns.on(child.name, () => {});
        if (child._ === 'request') ns.request(child.name, (ctx: any) => ctx.respond({}));
      }
      return ns;
    });
  }
}
const heavyHandler = heavyImpl.build();

describe('compileHandlerDefinition', () => {
  bench('tiny  (1 incoming, 1 outgoing)', () => {
    compileHandlerDefinition(tinyHandler);
  });

  bench('medium (~10 events, 2 channels, 1 namespace)', () => {
    compileHandlerDefinition(mediumHandler);
  });

  bench('heavy (~50 events, 10 channels, 2 namespaces)', () => {
    compileHandlerDefinition(heavyHandler);
  });
});
