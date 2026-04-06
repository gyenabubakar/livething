/* oxlint-disable @typescript-eslint/no-explicit-any */

import { generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type {
  GeneratePrimitive,
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

const basic = stream(start('ask-ai'));
const _eventLiteral: 'ask-ai' = basic.event;
void _eventLiteral;

// @ts-expect-error — event is 'ask-ai', not 'other'
const _wrongEvent: 'other' = basic.event;
void _wrongEvent;

// ===========================================================================
// 3. stream() carries nudges only
// ===========================================================================

const withNudges = stream(
  start('ask-ai'),
  nudge('cancel'),
  nudge('add-context', (p: unknown) => p as { context: string }),
);

const _streamTag: 'stream' = withNudges.__wskit;
const _streamKind: PrimitiveKind = withNudges.__kind;
const _nudges: readonly [
  NudgeDeclaration<'cancel', unknown>,
  NudgeDeclaration<'add-context', { context: string }>,
] = withNudges.nudges;
void [_streamTag, _streamKind, _nudges];

// ===========================================================================
// 4. start() with parse function validator
// ===========================================================================

const withParse = stream(
  start('ask-ai', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    return { prompt: String(obj.prompt) };
  }),
);

const _parseType: StreamPrimitive<'ask-ai', { prompt: string }, readonly []> = withParse;
void _parseType;

// ===========================================================================
// 5. start() with StandardSchema validator
// ===========================================================================

declare const askSchema: StandardSchemaV1<unknown, { prompt: string; model: string }>;

const withSchema = stream(start('ask-ai', askSchema));
const _schemaType: StreamPrimitive<'ask-ai', { prompt: string; model: string }, readonly []> =
  withSchema;
void _schemaType;

// ===========================================================================
// 6. generate() — event name preserved as literal
// ===========================================================================

const basicGenerate = generate(
  'ask-ai',
  async function* () {
    yield { text: 'hello' };
  },
  { chunks: t<{ text: string }>() },
);

const _generateEvent: 'ask-ai' = basicGenerate.event;
const _generateTag: 'generate' = basicGenerate.__wskit;
const _generateKind: PrimitiveKind = basicGenerate.__kind;
void [_generateEvent, _generateTag, _generateKind];

// ===========================================================================
// 7. generate() can carry a custom ctx type
// ===========================================================================

type StreamCtx = {
  send(event: 'message', payload: { text: string }): void;
  nudges(value: unknown): readonly NudgeMessage<'cancel', unknown>[];
};

const withCtx = generate(
  'ask-ai',
  async function* (ctx: StreamCtx, payload: { prompt: string }) {
    ctx.send('message', { text: payload.prompt });
    const nudges = ctx.nudges(yield { text: payload.prompt });
    const _event: 'cancel' = nudges[0]!.event;
    void _event;
  },
  { chunks: t<{ text: string }>() },
);

const _ctxType: GeneratePrimitive<
  'ask-ai',
  { prompt: string },
  { text: string },
  readonly NudgeDeclaration[],
  StreamCtx
> = withCtx;
void _ctxType;

// ===========================================================================
// 8. A generator can still annotate yield-return manually
// ===========================================================================

const _manualYield = generate(
  'ask-ai',
  async function* () {
    const nudges: readonly NudgeMessage<'cancel', unknown>[] = yield { text: 'token' };
    for (const n of nudges) {
      const _event: 'cancel' = n.event;
      void _event;
    }
  },
  { chunks: t<{ text: string }>() },
);
void _manualYield;

// ===========================================================================
// 9. start() carries broadcast option
// ===========================================================================

const broadcastStart = start('ask-ai', undefined, { broadcast: true });
const _broadcastStart: StreamStartDeclaration<'ask-ai', unknown> = broadcastStart;
void _broadcastStart;

const broadcastStream = stream(start('ask-ai', undefined, { broadcast: true }));
const _broadcast: boolean = broadcastStream.broadcast;
void _broadcast;

// ===========================================================================
// 10. stream and generate are PrimitiveRefs
// ===========================================================================

const _streamRef: PrimitiveRef = stream;
const _streamKey: symbol = stream.__key;
const _generateRef: PrimitiveRef = generate;
const _generateKey: symbol = generate.__key;
void [_streamRef, _streamKey, _generateRef, _generateKey];
