import { received } from '~/received.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ReceivedEvent } from '~/received.ts';

// ===========================================================================
// 1. Event name preserved as literal
// ===========================================================================

const sendMessage = received('send-message');
const _eventLiteral: 'send-message' = sendMessage.event;
void _eventLiteral;

// @ts-expect-error — event is 'send-message', not 'join'
const _wrongEvent: 'join' = sendMessage.event;
void _wrongEvent;

// ===========================================================================
// 2. Without validator — payload is unknown
// ===========================================================================

const ping = received('ping');
const _unknownPayload: ReceivedEvent<'ping', unknown> = ping;
void _unknownPayload;

// ===========================================================================
// 3. With parse function — payload inferred from return type
// ===========================================================================

const parsed = received('parsed-message', (value: unknown) => value as { text: string });
const _parsedType: ReceivedEvent<'parsed-message', { text: string }> = parsed;
void _parsedType;

// ===========================================================================
// 4. With StandardSchema — payload inferred from schema output
// ===========================================================================

declare const messageSchema: StandardSchemaV1<unknown, { text: string; from: string }>;

const schemaReceived = received('schema-message', messageSchema);
const _schemaType: ReceivedEvent<'schema-message', { text: string; from: string }> = schemaReceived;
void _schemaType;
