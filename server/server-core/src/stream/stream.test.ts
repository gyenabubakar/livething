/* oxlint-disable @typescript-eslint/no-explicit-any */

import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamChunksDeclaration,
  StreamPrimitive,
  StreamStartDeclaration,
} from '~/stream/stream.ts';

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
// 2. chunks() — chunk shape carried from t()
// ===========================================================================

const chunkDecl = chunks(t<{ text: string }>());
const _chunkDeclType: StreamChunksDeclaration<{ text: string }> = chunkDecl;
void _chunkDeclType;

// ===========================================================================
// 3. stream() — event, chunks, and nudges are preserved
// ===========================================================================

const aiStream = stream(
  start('ask-ai'),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
  nudge('add-context', (p: unknown) => p as { context: string }),
);

const _eventLiteral: 'ask-ai' = aiStream.event;
const _streamTag: 'stream' = aiStream.__wskit;
const _streamKind: PrimitiveKind = aiStream.__kind;
const _streamType: StreamPrimitive<
  'ask-ai',
  unknown,
  { text: string },
  readonly [
    NudgeDeclaration<'cancel', unknown>,
    NudgeDeclaration<'add-context', { context: string }>,
  ]
> = aiStream;
void [_eventLiteral, _streamTag, _streamKind, _streamType];

// ===========================================================================
// 4. start() with parse function validator
// ===========================================================================

const withParse = stream(
  start('ask-ai', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    return { prompt: String(obj.prompt) };
  }),
  chunks(t<{ text: string }>()),
);

const _parseType: StreamPrimitive<'ask-ai', { prompt: string }, { text: string }, readonly []> =
  withParse;
void _parseType;

// ===========================================================================
// 5. start() with StandardSchema validator
// ===========================================================================

declare const askSchema: StandardSchemaV1<unknown, { prompt: string; model: string }>;

const withSchema = stream(start('ask-ai', askSchema), chunks(t<{ text: string }>()));
const _schemaType: StreamPrimitive<
  'ask-ai',
  { prompt: string; model: string },
  { text: string },
  readonly []
> = withSchema;
void _schemaType;

// ===========================================================================
// 6. generate() reads payload, chunks, and nudges from the stream
// ===========================================================================

const generated = generate(aiStream, async function* (_ctx, payload) {
  const _prompt: unknown = payload;
  void _prompt;

  const next = yield { text: 'hello' };
  const _next: any = next;
  void _next;
});

const _generateTag: 'generate' = generated.__wskit;
const _generateKind: PrimitiveKind = generated.__kind;
const _generateType: GeneratePrimitive<typeof aiStream> = generated;
void [_generateTag, _generateKind, _generateType];

// ===========================================================================
// 7. generate() can carry a custom ctx type while still using stream-local types
// ===========================================================================

type StreamCtx = {
  send(event: 'message', payload: { text: string }): void;
  nudges(
    value: unknown,
  ): readonly [
    { event: 'cancel'; payload: unknown },
    { event: 'add-context'; payload: { context: string } },
  ][number][];
};

const withCtx = generate(
  stream(
    start('ask-ai', (p: unknown) => p as { prompt: string }),
    chunks(t<{ text: string }>()),
    nudge('cancel'),
    nudge('add-context', (p: unknown) => p as { context: string }),
  ),
  async function* (ctx: StreamCtx, payload) {
    ctx.send('message', { text: payload.prompt });
    const nudges = ctx.nudges(yield { text: payload.prompt });
    const _event: 'cancel' | 'add-context' = nudges[0]!.event;
    void _event;
  },
);

const _ctxType: GeneratePrimitive<
  StreamPrimitive<
    'ask-ai',
    { prompt: string },
    { text: string },
    readonly [
      NudgeDeclaration<'cancel', unknown>,
      NudgeDeclaration<'add-context', { context: string }>,
    ]
  >,
  StreamCtx
> = withCtx;
void _ctxType;

// ===========================================================================
// 8. start() carries broadcast option
// ===========================================================================

const broadcastStart = start('ask-ai', undefined, { broadcast: true });
const _broadcastStart: StreamStartDeclaration<'ask-ai', unknown> = broadcastStart;
void _broadcastStart;

const broadcastStream = stream(
  start('ask-ai', undefined, { broadcast: true }),
  chunks(t<{ text: string }>()),
);
const _broadcast: boolean = broadcastStream.broadcast;
void _broadcast;

// ===========================================================================
// 9. stream and generate are PrimitiveRefs
// ===========================================================================

const _streamRef: PrimitiveRef = stream;
const _streamKey: symbol = stream.__key;
const _generateRef: PrimitiveRef = generate;
const _generateKey: symbol = generate.__key;
void [_streamRef, _streamKey, _generateRef, _generateKey];
