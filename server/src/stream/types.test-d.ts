/**
 * Compile-time fixture: stream API type-safety in all four scopes.
 *
 * This file must compile with zero errors. @ts-expect-error directives
 * assert that invalid code is correctly rejected. No runtime is involved.
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

// ─── Scope 1: top-level server ─────────────────────────────────

withStreams(server('app')).stream(aiPrompt, (s) =>
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

withStreams(server('app')).stream(aiPrompt, (s) =>
  s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
    // @ts-expect-error — no nudges declared, ctx.nudges must not exist
    ctx.nudges;
    yield { token: 'hi' };
  }),
);

withStreams(server('app')).stream(aiPrompt, (s) => {
  // @ts-expect-error — .chunk(...) must be declared before .generate()
  return s.generate(async function* (_ctx, _payload) {
    yield { token: 'hi' };
  });
});

// ─── Scope 2: group ─────────────────────────────────────────────

const groupBase = withStreams(server('app'));

groupBase.group((g) =>
  g.stream(aiPrompt, (s) =>
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

groupBase.group((g) =>
  g.stream(aiPrompt, (s) =>
    s.chunk(chunkSchema).generate(async function* (ctx, _payload) {
      // @ts-expect-error — no nudges in group scope stream, ctx.nudges must not exist
      ctx.nudges;
      yield { token: 'hi' };
    }),
  ),
);

// ─── Scope 3: namespace ─────────────────────────────────────────

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

// ─── Scope 4: channel ────────────────────────────────────────────

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

withStreams(server('app')).stream(aiPrompt, (s) =>
  s
    .chunk(chunkSchema)
    .broadcast()
    .generate(async function* (_ctx, payload) {
      void (payload.prompt satisfies string);
      yield { token: 'hi' };
    }),
);

// ─── Parent builder preserved after .stream() ────────────────────

const afterStream = withStreams(server('app')).stream(aiPrompt, (s) =>
  s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
    void (payload.prompt satisfies string);
    yield { token: 'hi' };
  }),
);

afterStream.stream(
  event('second-stream', (p: unknown) => p as { id: string }),
  (s) =>
    s.chunk(chunkSchema).generate(async function* (_ctx, payload) {
      void (payload.id satisfies string);
      yield { token: 'hi' };
    }),
);
