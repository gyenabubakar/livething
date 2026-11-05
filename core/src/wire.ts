import { WIRE_LIMITS } from './identifier.ts';

/** Metadata describing the exchange that produced a message. */
export interface LiveThingExchangeMetadata {
  id?: string;
  source?: 'server' | 'client';
}

/** Metadata describing the channel a message belongs to. */
export interface LiveThingChannelMetadata {
  name: string;
  family?: string;
  unsubscribeId?: string;
  membership?: 'persistent' | 'ephemeral';
  inbox?: boolean;
  readReceipts?: boolean;
}

/** Metadata describing delivery identity and ordering. */
export interface LiveThingDeliveryMetadata {
  id?: string;
  seq?: number;
}

/** Metadata describing a stream and its delivery state. */
export interface LiveThingStreamMetadata {
  id: string;
  event?: string;
  durability?: 'ephemeral' | 'persistent';
  seq?: number;
  nudgeId?: string;
  terminated?: boolean;
}

/** Framework metadata carried in the third item of every wire tuple. */
export interface LiveThingMetadata {
  exchange?: LiveThingExchangeMetadata;
  channel?: LiveThingChannelMetadata;
  delivery?: LiveThingDeliveryMetadata;
  stream?: LiveThingStreamMetadata;
}

/** One message as it travels through the LiveThing wire protocol. */
export interface Message {
  event: string;
  payload: unknown;
  /** Internal callers may omit this; encoding always writes the tuple's null slot. */
  metadata?: LiveThingMetadata | null;
  /**
   * The bytes of a binary message, after its envelope. Absent on a text message. On a
   * received message it is a view of the whole frame, so `bytes.buffer` holds the header
   * and the envelope too.
   */
  bytes?: Uint8Array;
}

/** The only JSON shape accepted on the LiveThing wire. */
export type WireFrame = readonly [
  event: string,
  payload: unknown,
  metadata: LiveThingMetadata | null,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(group: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(group).every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function isOptionalString(group: Record<string, unknown>, key: string, limit: number): boolean {
  return !(key in group) || isBoundedString(group[key], limit);
}

function isOptionalBoolean(group: Record<string, unknown>, key: string): boolean {
  return !(key in group) || typeof group[key] === 'boolean';
}

function isOptionalSequence(group: Record<string, unknown>): boolean {
  return (
    !('seq' in group) ||
    (typeof group.seq === 'number' && Number.isSafeInteger(group.seq) && group.seq >= 0)
  );
}

function isExchangeMetadata(group: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(group, ['id', 'source']) &&
    isOptionalString(group, 'id', WIRE_LIMITS.wireId) &&
    (!('source' in group) || group.source === 'server' || group.source === 'client')
  );
}

function isChannelMetadata(group: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(group, [
      'name',
      'family',
      'unsubscribeId',
      'membership',
      'inbox',
      'readReceipts',
    ]) &&
    isBoundedString(group.name, WIRE_LIMITS.channel) &&
    isOptionalString(group, 'family', WIRE_LIMITS.channelFamily) &&
    isOptionalString(group, 'unsubscribeId', WIRE_LIMITS.wireId) &&
    (!('membership' in group) ||
      group.membership === 'persistent' ||
      group.membership === 'ephemeral') &&
    isOptionalBoolean(group, 'inbox') &&
    isOptionalBoolean(group, 'readReceipts')
  );
}

function isDeliveryMetadata(group: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(group, ['id', 'seq']) &&
    isOptionalString(group, 'id', WIRE_LIMITS.wireId) &&
    isOptionalSequence(group)
  );
}

function isStreamMetadata(group: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(group, ['id', 'event', 'durability', 'seq', 'nudgeId', 'terminated']) &&
    isBoundedString(group.id, WIRE_LIMITS.streamId) &&
    isOptionalString(group, 'event', WIRE_LIMITS.event) &&
    (!('durability' in group) ||
      group.durability === 'ephemeral' ||
      group.durability === 'persistent') &&
    isOptionalSequence(group) &&
    isOptionalString(group, 'nudgeId', WIRE_LIMITS.wireId) &&
    isOptionalBoolean(group, 'terminated')
  );
}

function isMetadata(value: unknown): value is LiveThingMetadata | null {
  if (value === null) return true;

  if (!isRecord(value)) return false;

  if (Object.keys(value).length === 0) return false;

  for (const [key, group] of Object.entries(value)) {
    if (!['exchange', 'channel', 'delivery', 'stream'].includes(key)) return false;

    if (!isRecord(group)) return false;

    if (Object.keys(group).length === 0) return false;

    if (key === 'exchange' && !isExchangeMetadata(group)) return false;

    if (key === 'channel' && !isChannelMetadata(group)) return false;

    if (key === 'delivery' && !isDeliveryMetadata(group)) return false;

    if (key === 'stream' && !isStreamMetadata(group)) return false;
  }

  return true;
}

/** Encode a message as the fixed three-item JSON tuple. */
export function encodeMessage(message: Message): string {
  const metadata = message.metadata ?? null;
  if (!isBoundedString(message.event, WIRE_LIMITS.event)) {
    throw new TypeError('invalid LiveThing message');
  }

  if (!isMetadata(metadata)) {
    throw new TypeError('invalid LiveThing metadata');
  }

  return JSON.stringify([message.event, message.payload, metadata] satisfies WireFrame);
}

/** Decode a fixed three-item JSON tuple, returning null for malformed input. */
export function decodeMessage(raw: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(value) || value.length !== 3) return null;

  const [event, payload, metadata] = value;
  if (!isBoundedString(event, WIRE_LIMITS.event) || !isMetadata(metadata)) return null;

  return { event, payload, metadata };
}
