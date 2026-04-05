/* oxlint-disable @typescript-eslint/no-explicit-any */

import { incoming } from '~/primitives/incoming.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const sendMsg = incoming('send-message', async (_ctx, _payload) => {});
const _eventLiteral: 'send-message' = sendMsg.event;
void _eventLiteral;

// @ts-expect-error — event is 'send-message', not 'join'
const _wrongEvent: 'join' = sendMsg.event;
void _wrongEvent;

// Different events produce different literal types
const join = incoming('join-room', async () => {});
const _joinEvent: 'join-room' = join.event;
void _joinEvent;

// ===========================================================================
// 2. Without validator — payload is unknown
// ===========================================================================

const noValidator = incoming('ping', async (_ctx, payload) => {
  const _unknown: unknown = payload;
  void _unknown;
});

const _noValType: IncomingPrimitive<'ping', unknown> = noValidator;
void _noValType;

// ===========================================================================
// 3. With parse function — payload inferred from return type
// ===========================================================================

const withParse = incoming(
  'send-message',
  async (_ctx, payload) => {
    const _text: string = payload.text;
    void _text;
  },
  {
    validator: (p: unknown) => {
      const obj = p as Record<string, unknown>;
      if (typeof obj.text !== 'string') throw new Error('text required');
      return { text: obj.text };
    },
  },
);

const _parseType: IncomingPrimitive<'send-message', { text: string }> = withParse;
void _parseType;

// ===========================================================================
// 4. With StandardSchema — payload inferred from schema output
// ===========================================================================

declare const messageSchema: StandardSchemaV1<unknown, { text: string; from: string }>;

const withSchema = incoming(
  'send-message',
  async (_ctx, payload) => {
    const _text: string = payload.text;
    const _from: string = payload.from;
    void [_text, _from];
  },
  { validator: messageSchema },
);

const _schemaType: IncomingPrimitive<'send-message', { text: string; from: string }> = withSchema;
void _schemaType;

// ===========================================================================
// 5. Primitive base fields present
// ===========================================================================

const _tag: 'incoming' = sendMsg.__wskit;
const _kind: PrimitiveKind = sendMsg.__kind;
void [_tag, _kind];

// ===========================================================================
// 6. incoming is a PrimitiveRef (for dependency declarations)
// ===========================================================================

const _ref: PrimitiveRef = incoming;
const _key: symbol = incoming.__key;
void [_ref, _key];

// ===========================================================================
// 7. Handler function is stored on the instance
// ===========================================================================

async function myHandler(_ctx: any, _payload: unknown) {}
const withHandler = incoming('test', myHandler);
const _storedHandler: (_ctx: any, _payload: unknown) => void | Promise<void> = withHandler.handler;
void _storedHandler;

// ===========================================================================
// 8. Validator is stored on the instance
// ===========================================================================

const _hasValidator: typeof withParse.validator = withParse.validator;
void _hasValidator;

const _noVal: undefined = noValidator.validator as undefined;
void _noVal;
