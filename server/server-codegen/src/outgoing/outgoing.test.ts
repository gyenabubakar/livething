import { outgoing } from '~/outgoing/outgoing.ts';
import { t } from '~/t.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const message = outgoing('message', t<{ text: string }>());
const _eventLiteral: 'message' = message.event;
void _eventLiteral;

// @ts-expect-error — event is 'message', not 'alert'
const _wrongEvent: 'alert' = message.event;
void _wrongEvent;

// ===========================================================================
// 2. Payload type carried from t()
// ===========================================================================

const _payloadType: OutgoingPrimitive<'message', { text: string }> = message;
void _payloadType;

// ===========================================================================
// 3. Primitive base fields present
// ===========================================================================

const _tag: 'outgoing' = message.__wskit;
const _kind: PrimitiveKind = message.__kind;
void [_tag, _kind];

// ===========================================================================
// 4. outgoing is a PrimitiveRef
// ===========================================================================

const _ref: PrimitiveRef = outgoing;
const _key: symbol = outgoing.__key;
void [_ref, _key];
