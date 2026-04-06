/* oxlint-disable @typescript-eslint/no-explicit-any */

import { generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type {
  NudgeDeclaration,
  NudgeMessage,
  StreamPrimitive,
  StreamStartDeclaration,
} from '~/primitives/stream.ts';

// ===========================================================================
// 1. start() — event name preserved as literal
// ===========================================================================

const basicStart = start('ask-ai');
const _startLiteral: 'ask-ai' = basicStart.event;
void _startLiteral;

// @ts-expect-error — event is 'ask-ai', not 'other'
const _wrongStart: 'other' = basicStart.event;
void _wrongStart;

// ===========================================================================
// 2. stream() — event name preserved as literal
// ===========================================================================

const basic = stream(
  start('ask-ai'),
  generate(
    async function* () {
      yield { text: 'hello' };
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _eventLiteral: 'ask-ai' = basic.event;
void _eventLiteral;

// @ts-expect-error — event is 'ask-ai', not 'other'
const _wrongEvent: 'other' = basic.event;
void _wrongEvent;

// ===========================================================================
// 3. Chunk type carried from generate options
// ===========================================================================

const _tag: 'stream' = basic.__wskit;
const _kind: PrimitiveKind = basic.__kind;
void [_tag, _kind];

// ===========================================================================
// 4. start() with parse function validator
// ===========================================================================

const withParse = stream(
  start('ask-ai', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    return { prompt: String(obj.prompt) };
  }),
  generate(
    async function* (_ctx, payload) {
      const _prompt: string = payload.prompt;
      void _prompt;
      yield { text: 'token' };
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _parseType: StreamPrimitive<'ask-ai', { prompt: string }, { text: string }> = withParse;
void _parseType;

// ===========================================================================
// 5. start() with StandardSchema validator
// ===========================================================================

declare const askSchema: StandardSchemaV1<unknown, { prompt: string; model: string }>;

const withSchema = stream(
  start('ask-ai', askSchema),
  generate(
    async function* (_ctx, payload) {
      const _prompt: string = payload.prompt;
      const _model: string = payload.model;
      void [_prompt, _model];
      yield { text: 'token' };
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _schemaType: StreamPrimitive<'ask-ai', { prompt: string; model: string }, { text: string }> =
  withSchema;
void _schemaType;

// ===========================================================================
// 6. Nudge declarations carried on the primitive
// ===========================================================================

const withNudges = stream(
  start('ask-ai'),
  nudge('cancel'),
  nudge('add-context', (p: unknown) => p as { context: string }),
  generate(
    async function* () {
      yield { text: 'token' };
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _nudges: readonly [
  NudgeDeclaration<'cancel', unknown>,
  NudgeDeclaration<'add-context', { context: string }>,
] = withNudges.nudges;
void _nudges;

// ===========================================================================
// 7. nudge() — event name preserved as literal
// ===========================================================================

const cancelNudge = nudge('cancel');
const _nudgeEvent: 'cancel' = cancelNudge.event;
void _nudgeEvent;

const contextNudge = nudge('add-context', (p: unknown) => p as { context: string });
const _contextEvent: 'add-context' = contextNudge.event;
void _contextEvent;

// ===========================================================================
// 8. nudge() with StandardSchema
// ===========================================================================

declare const contextSchema: StandardSchemaV1<unknown, { context: string }>;
const schemaNudge = nudge('add-context', contextSchema);
const _schemaNudgeType: NudgeDeclaration<'add-context', { context: string }> = schemaNudge;
void _schemaNudgeType;

// ===========================================================================
// 9. Generator can carry a custom ctx type
// ===========================================================================

type StreamCtx = {
  send(event: 'message', payload: { text: string }): void;
  nudges<T>(value: T): T;
};

const withCtx = stream(
  start('ask-ai', (p: unknown) => p as { prompt: string }),
  nudge('cancel'),
  generate(
    async function* (ctx: StreamCtx, payload) {
      ctx.send('message', { text: payload.prompt });
      const raw = yield { text: 'token' };
      const _nudges = ctx.nudges(raw);
      void _nudges;
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _ctxType: StreamPrimitive<
  'ask-ai',
  { prompt: string },
  { text: string },
  readonly [NudgeDeclaration<'cancel', unknown>],
  StreamCtx
> = withCtx;
void _ctxType;

// ===========================================================================
// 10. A generator can still annotate yield-return manually
// ===========================================================================

const _manualYield = stream(
  start('ask-ai'),
  nudge('cancel'),
  generate(
    async function* () {
      const nudges: readonly NudgeMessage<'cancel', unknown>[] = yield { text: 'token' };
      for (const n of nudges) {
        const _event: 'cancel' = n.event;
        void _event;
      }
    },
    { chunks: t<{ text: string }>() },
  ),
);
void _manualYield;

// ===========================================================================
// 11. start() carries broadcast option
// ===========================================================================

const broadcastStart = start('ask-ai', undefined, { broadcast: true });
const _broadcastStart: StreamStartDeclaration<'ask-ai', unknown> = broadcastStart;
void _broadcastStart;

const broadcastStream = stream(
  start('ask-ai', undefined, { broadcast: true }),
  generate(
    async function* () {
      yield { text: 'token' };
    },
    { chunks: t<{ text: string }>() },
  ),
);

const _broadcast: boolean = broadcastStream.broadcast;
void _broadcast;

// ===========================================================================
// 12. stream is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = stream;
const _key: symbol = stream.__key;
void [_ref, _key];
