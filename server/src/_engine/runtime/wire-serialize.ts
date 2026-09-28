import type { LiveThingProtocol } from './protocol.ts';

/** Convert the internal routing view to nested wire metadata. */
export function metadataFromLiveThing(
  input: Partial<LiveThingProtocol> | Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const livething = input as Partial<LiveThingProtocol> | undefined;
  if (!livething) return null;

  const metadata: Record<string, unknown> = {};
  if (livething.correlationId !== undefined || livething.source !== undefined) {
    metadata.exchange = {
      ...(livething.correlationId === undefined ? {} : { id: livething.correlationId }),
      ...(livething.source === undefined ? {} : { source: livething.source }),
    };
  }

  if (
    livething.channel !== undefined ||
    livething.unsubscribeId !== undefined ||
    livething.channelMembership !== undefined ||
    livething.inbox !== undefined ||
    livething.readReceipts !== undefined
  ) {
    metadata.channel = {
      name: livething.channel,
      ...(typeof livething.channelFamily === 'string' ? { family: livething.channelFamily } : {}),
      ...(livething.unsubscribeId === undefined ? {} : { unsubscribeId: livething.unsubscribeId }),
      ...(livething.channelMembership === undefined
        ? {}
        : { membership: livething.channelMembership }),
      ...(livething.inbox === undefined ? {} : { inbox: livething.inbox }),
      ...(livething.readReceipts === undefined ? {} : { readReceipts: livething.readReceipts }),
    };
  }

  if (livething.messageId !== undefined || livething.deliverySeq !== undefined) {
    metadata.delivery = {
      ...(livething.messageId === undefined ? {} : { id: livething.messageId }),
      ...(livething.deliverySeq === undefined ? {} : { seq: livething.deliverySeq }),
    };
  }

  if (livething.streamId !== undefined) {
    metadata.stream = {
      id: livething.streamId,
      ...(livething.eventName === undefined ? {} : { event: livething.eventName }),
      ...(livething.streamDurability === undefined
        ? {}
        : { durability: livething.streamDurability }),
      ...(livething.streamSeq === undefined ? {} : { seq: livething.streamSeq }),
      ...(livething.streamNudgeId === undefined ? {} : { nudgeId: livething.streamNudgeId }),
      ...(livething.streamTerminated === undefined
        ? {}
        : { terminated: livething.streamTerminated }),
    };
  }

  return Object.keys(metadata).length === 0 ? null : metadata;
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
