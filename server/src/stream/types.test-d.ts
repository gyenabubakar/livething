/**
 * Compile-time fixture: stream API type-safety.
 *
 * This file must compile with zero errors. @ts-expect-error directives
 * assert that invalid code is correctly rejected. No runtime is involved.
 *
 * Server-level `.stream(...)` returns a primitive that you mount with `.use()`.
 * Inside `.namespace(...)` and `.channel(...)` it auto-seals onto the parent
 * scope. `.stream()` is not exposed inside `.group(...)`.
 */

import { server } from '~/_builder/server-builder.ts';
import { withChannels } from '~/channel/with.ts';
import { event } from '~/event.ts';
import { withNamespaces } from '~/namespace/with.ts';
import { withStreams } from '~/stream/with.ts';

const aiPrompt = event('ai-prompt', (p: unknown) => p as { prompt: string });
const pause = event('pause', (p: unknown) => p as { reason: string });
const speedUp = event('speed-up', (p: unknown) => p as { factor: number });

function chunkSchema(p: unknown) {
  return p as { token: string };
}

// ─── Scope 1: top-level server (returns primitive) ─────────────

const topStream = withStreams(server('app')).stream(aiPrompt, (s) =>
  s
    .chunk(chunkSchema)
    .nudge(pause)
    .nudge(speedUp)
    .generate(async function* (ctx, payload) {
      void (payload.prompt satisfies string);

      const raw = yield { token: 'hi' };
      const nudges = ctx.nudges(raw);

      for (const n of nudges) {
        if (n.event === 'pause') {
          void (n.payload.reason satisfies string);
        }
        if (n.event === 'speed-up') {
          void (n.payload.factor satisfies number);
        }
      }
    }),
);
void topStream;

const noNudgeStream = withStreams(server('app')).stream(aiPrompt, (s) =>
  s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
    // @ts-expect-error — no nudges declared, ctx.nudges must not exist
    ctx.nudges;
    yield { token: 'hi' };
  }),
);
void noNudgeStream;

withStreams(server('app')).stream(aiPrompt, (s) => {
  // @ts-expect-error — .chunk(...) must be declared before .generate()
  return s.generate(async function* (_ctx, _payload) {
    yield { token: 'hi' };
  });
});

// ─── Scope 2: group does NOT expose .stream() ─────────────────

const groupBase = withStreams(server('app'));

groupBase.group((g) => {
  // @ts-expect-error — `.stream()` is server-only; mount a stream primitive with `.use()` instead.
  g.stream(aiPrompt, (s) => s.chunk(chunkSchema).generate(async function* () {}));
  return g;
});

// ─── Scope 3: namespace (auto-seals onto namespace scope) ──────

withNamespaces(withStreams(server('app'))).namespace('ai', (ns) =>
  ns.stream(aiPrompt, (s) =>
    s
      .chunk(chunkSchema)
      .nudge(pause)
      .generate(async function* (ctx, payload) {
        void (payload.prompt satisfies string);
        const raw = yield { token: 'hi' };
        const nudges = ctx.nudges(raw);
        for (const n of nudges) {
          if (n.event === 'pause') {
            void (n.payload.reason satisfies string);
          }
        }
      }),
  ),
);

withNamespaces(withStreams(server('app'))).namespace('ai', (ns) =>
  ns.stream(aiPrompt, (s) =>
    s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
      // @ts-expect-error — no nudges, ctx.nudges must not exist in namespace scope
      ctx.nudges;
      yield { token: 'hi' };
    }),
  ),
);

// ─── Scope 4: channel (auto-seals onto channel scope) ──────────

withStreams(withChannels(server('app'))).channel('lobby', (ch) =>
  ch.stream(aiPrompt, (s) =>
    s
      .chunk(chunkSchema)
      .nudge(pause)
      .generate(async function* (ctx, payload) {
        void (payload.prompt satisfies string);
        const raw = yield { token: 'hi' };
        const nudges = ctx.nudges(raw);
        for (const n of nudges) {
          if (n.event === 'pause') {
            void (n.payload.reason satisfies string);
          }
        }
      }),
  ),
);

withStreams(withChannels(server('app'))).channel('lobby', (ch) =>
  ch.stream(aiPrompt, (s) =>
    s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
      // @ts-expect-error — no nudges, ctx.nudges must not exist in channel scope
      ctx.nudges;
      yield { token: 'hi' };
    }),
  ),
);

// ─── Broadcast on builder ────────────────────────────────────────

const broadcastStream = withStreams(server('app')).stream(aiPrompt, (s) =>
  s
    .chunk(chunkSchema)
    .broadcast()
    .generate(async function* (_ctx, payload) {
      void (payload.prompt satisfies string);
      yield { token: 'hi' };
    }),
);
void broadcastStream;

// ─── Multiple top-level streams compose via .use() ───────────────

const baseMulti = withStreams(server('app'));
const stream1 = baseMulti.stream(aiPrompt, (s) =>
  s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
    void (payload.prompt satisfies string);
    yield { token: 'hi' };
  }),
);
const stream2 = baseMulti.stream(
  event('second-stream', (p: unknown) => p as { id: string }),
  (s) =>
    s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
      void (payload.id satisfies string);
      yield { token: 'hi' };
    }),
);
baseMulti.use(stream1).use(stream2);

// ─── StreamBundlePrimitive shape ────────────────────────────────
//
// Server-level `.stream(...)` returns a value that:
//  - carries `__wskit: 'group'` so `.use()` expands it like any other group
//  - exposes a readonly `primitives` array with the inner primitives the
//    runtime actually registers (the stream-start primitive plus the
//    generate primitive — and any nudges)

void (stream1.__wskit satisfies 'group');
void (stream1.primitives satisfies readonly unknown[]);

// `__wskit` must be exactly `'group'` — a wider string type would mean the
// expansion path in `.use()` could not narrow correctly.
type StreamBundleTag = (typeof stream1)['__wskit'];
type _AssertExactGroupTag = StreamBundleTag extends 'group'
  ? 'group' extends StreamBundleTag
    ? true
    : false
  : false;
const _streamBundleTagIsExactlyGroup: _AssertExactGroupTag = true;
void _streamBundleTagIsExactlyGroup;
