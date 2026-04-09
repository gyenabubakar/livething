/* oxlint-disable @typescript-eslint/no-explicit-any */

import { h } from '~/h.ts';
import { incoming } from '~/incoming/incoming.ts';
import { received } from '~/received.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const sendMsg = incoming(received('send-message'), async (_ctx, _payload) => {});
const _eventLiteral: 'send-message' = sendMsg.event;
void _eventLiteral;

// @ts-expect-error — event is 'send-message', not 'join'
const _wrongEvent: 'join' = sendMsg.event;
void _wrongEvent;

const join = incoming(received('join-room'), async () => {});
const _joinEvent: 'join-room' = join.event;
void _joinEvent;

// ===========================================================================
// 2. Without validator — payload is unknown
// ===========================================================================

const noValidator = incoming(received('ping'), async (_ctx, payload) => {
  const _unknown: unknown = payload;
  void _unknown;
});

const _noValType: IncomingPrimitive<'ping', unknown> = noValidator;
void _noValType;

// ===========================================================================
// 3. With parse function — payload inferred from return type
// ===========================================================================

const withParse = incoming(
  received('send-message', (p: unknown) => {
    const obj = p as Record<string, unknown>;
    if (typeof obj.text !== 'string') throw new Error('text required');
    return { text: obj.text };
  }),
  async (_ctx, payload) => {
    const _text: string = payload.text;
    void _text;
  },
);

const _parseType: IncomingPrimitive<'send-message', { text: string }> = withParse;
void _parseType;

// ===========================================================================
// 4. With StandardSchema — payload inferred from schema output
// ===========================================================================

declare const messageSchema: StandardSchemaV1<unknown, { text: string; from: string }>;

const withSchema = incoming(received('send-message', messageSchema), async (_ctx, payload) => {
  const _text: string = payload.text;
  const _from: string = payload.from;
  void [_text, _from];
});

const _schemaType: IncomingPrimitive<'send-message', { text: string; from: string }> = withSchema;
void _schemaType;

// ===========================================================================
// 5. With received(...) — event and payload come from the contract
// ===========================================================================

const receivedMessage = received(
  'received-message',
  (value: unknown) => value as { text: string; from: string },
);

const withReceived = incoming(receivedMessage, async (_ctx, payload) => {
  const _text: string = payload.text;
  const _from: string = payload.from;
  void [_text, _from];
});

const _receivedType: IncomingPrimitive<'received-message', { text: string; from: string }> =
  withReceived;
void _receivedType;

// ===========================================================================
// 6. Carried ctx type
// ===========================================================================

type ChatCtx = {
  reply(text: string): void;
};

const withCtx = incoming(received('ping'), async (ctx: ChatCtx, payload) => {
  ctx.reply('pong');
  const _unknown: unknown = payload;
  void _unknown;
});

const _ctxType: IncomingPrimitive<'ping', unknown, ChatCtx> = withCtx;
void _ctxType;

// ===========================================================================
// 7. Primitive base fields present
// ===========================================================================

const _tag: 'incoming' = sendMsg.__wskit;
const _kind: PrimitiveKind = sendMsg.__kind;
void [_tag, _kind];

// ===========================================================================
// 8. incoming is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = incoming;
const _key: symbol = incoming.__key;
void [_ref, _key];

// ===========================================================================
// 9. Handler function is stored on the instance
// ===========================================================================

async function myHandler(_ctx: any, _payload: unknown) {}
const withHandler = incoming(received('test'), myHandler);
const _storedHandler: (_ctx: any, _payload: unknown) => void | Promise<void> = withHandler.handler;
void _storedHandler;

// ===========================================================================
// 10. Validator is stored on the instance
// ===========================================================================

const _hasValidator: typeof withParse.validator = withParse.validator;
void _hasValidator;

const _noVal: undefined = noValidator.validator as undefined;
void _noVal;

// ===========================================================================
// 11. h() carries ctx into the callback
// ===========================================================================

type WrappedCtx = {
  reply(text: string): void;
};

const withWrappedCtx = incoming(
  received('wrapped-ping'),
  h(async (ctx: WrappedCtx, payload) => {
    ctx.reply('pong');
    const _unknown: unknown = payload;
    void _unknown;
  }),
);

const _wrappedCtxType: IncomingPrimitive<'wrapped-ping', unknown, WrappedCtx> = withWrappedCtx;
void _wrappedCtxType;
