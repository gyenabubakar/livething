import type { LiveThingProtocol } from './protocol.ts';

/** Convert the internal routing view to nested wire metadata. */
export function metadataFromLiveThing(
  input: Partial<LiveThingProtocol> | Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const livething = input as Partial<LiveThingProtocol> | undefined;
  if (!livething) return null;

  // Plain writes, not spreads of `cond ? {} : { key }`: this runs for every frame sent.
  let metadata: Record<string, unknown> | null = null;
  if (livething.correlationId !== undefined || livething.source !== undefined) {
    const exchange: Record<string, unknown> = {};
    if (livething.correlationId !== undefined) exchange.id = livething.correlationId;
    if (livething.source !== undefined) exchange.source = livething.source;
    metadata = { exchange };
  }

  if (
    livething.channel !== undefined ||
    livething.unsubscribeId !== undefined ||
    livething.channelMembership !== undefined ||
    livething.inbox !== undefined ||
    livething.readReceipts !== undefined ||
    livething.awareness !== undefined
  ) {
    const channel: Record<string, unknown> = { name: livething.channel };
    if (typeof livething.channelFamily === 'string') channel.family = livething.channelFamily;
    if (livething.unsubscribeId !== undefined) channel.unsubscribeId = livething.unsubscribeId;
    if (livething.channelMembership !== undefined) channel.membership = livething.channelMembership;
    if (livething.inbox !== undefined) channel.inbox = livething.inbox;

    if (livething.readReceipts !== undefined) channel.readReceipts = livething.readReceipts;
    if (livething.awareness !== undefined) channel.awareness = livething.awareness;
    (metadata ??= {}).channel = channel;
  }

  if (livething.messageId !== undefined || livething.deliverySeq !== undefined) {
    const delivery: Record<string, unknown> = {};
    if (livething.messageId !== undefined) delivery.id = livething.messageId;
    if (livething.deliverySeq !== undefined) delivery.seq = livething.deliverySeq;
    (metadata ??= {}).delivery = delivery;
  }

  if (livething.streamId !== undefined) {
    const stream: Record<string, unknown> = { id: livething.streamId };
    if (livething.eventName !== undefined) stream.event = livething.eventName;
    if (livething.streamDurability !== undefined) stream.durability = livething.streamDurability;
    if (livething.streamSeq !== undefined) stream.seq = livething.streamSeq;
    if (livething.streamNudgeId !== undefined) stream.nudgeId = livething.streamNudgeId;

    if (livething.streamTerminated !== undefined) stream.terminated = livething.streamTerminated;
    (metadata ??= {}).stream = stream;
  }

  if (livething.uploadId !== undefined) {
    const upload: Record<string, unknown> = { id: livething.uploadId };
    if (livething.uploadSeq !== undefined) upload.seq = livething.uploadSeq;
    if (livething.uploadSize !== undefined) upload.size = livething.uploadSize;
    (metadata ??= {}).upload = upload;
  }

  return metadata;
}

function isProtocolEventName(name: string): boolean {
  return name.length > 4 && name.startsWith('__') && name.endsWith('__');
}

export function serializeWireFrame(
  event: string,
  payload: unknown,
  livething?: Partial<LiveThingProtocol> | Record<string, unknown>,
): string {
  const noPayload =
    payload === undefined ||
    (isProtocolEventName(event) &&
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 0);

  return JSON.stringify([event, noPayload ? null : payload, metadataFromLiveThing(livething)]);
}

/**
 * {@link serializeWireFrame} for a payload that is already JSON text, such as the output of
 * `serializePayload`. The text goes into the frame as it is, so the payload is not parsed and
 * serialized again. The frame is the same string `serializeWireFrame` builds from the parsed value.
 */
export function serializeWireFrameJson(
  event: string,
  payloadJson: string,
  livething?: Partial<LiveThingProtocol> | Record<string, unknown>,
): string {
  const payload = payloadJson === '{}' && isProtocolEventName(event) ? 'null' : payloadJson;

  return `[${JSON.stringify(event)},${payload},${JSON.stringify(metadataFromLiveThing(livething))}]`;
}
