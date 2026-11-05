import { InternalError } from '@livething/core';
import { textOverLimit } from '~/_adapters/close.ts';
import { assertPayload, serializePayload } from '~/_engine/runtime/json-guard.ts';
import { serializeWireFrame } from '~/_engine/runtime/wire-serialize.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

export interface SendProtocolMessageOptions {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
}

/**
 * Send an internal protocol frame. Skips outgoing validation and decoration.
 *
 * The frame is `[event, payload, metadata]` — `payload` is the protocol
 * event's own data and metadata is grouped routing/correlation data. If the
 * frame can't be JSON-serialized (BigInt, circular, function, symbol), log it
 * and send a sanitized `__error__` frame instead so the client can still
 * correlate the request or stream.
 */
export function sendProtocolMessage(
  core: EngineCore,
  connection: RuntimeConnection,
  options: SendProtocolMessageOptions,
): void {
  const { event, payload, livething } = options;
  let wire: string;
  try {
    wire = serializeWireFrame(event, payload, livething);
  } catch (error) {
    core.logger.error(
      '[livething] Failed to serialize protocol frame; sending fallback __error__',
      {
        event,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    try {
      wire = serializeWireFrame('__error__', { code: InternalError.code }, livething);
    } catch (fallbackError) {
      core.logger.error('[livething] Fallback __error__ frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }

  connection.descriptor.send({ kind: 'text', text: wire });
}

export interface SendGapOptions {
  channelName: string | null;

  channelFamily: string | null;

  missedThrough: number;
}

/**
 * Send a `__gap__` frame to one connection. Signals that replay evicted
 * messages the reconnecting client had not yet seen — everything up to and
 * including `missedThrough` for this scope is gone from the store.
 */
export function sendGap(
  core: EngineCore,
  connection: RuntimeConnection,
  options: SendGapOptions,
): void {
  const { channelName, channelFamily, missedThrough } = options;
  const livething: Record<string, unknown> = {};
  if (channelName !== null) livething.channel = channelName;
  if (channelFamily !== null) livething.channelFamily = channelFamily;

  sendProtocolMessage(core, connection, {
    event: '__gap__',
    payload: { missedThrough },
    livething,
  });
}

export interface SendReplayOptions {
  channelName: string | null;

  channelFamily: string | null;

  event: string;

  payload: unknown;

  wire: { deliverySeq: number; messageId: string; channel?: string };
}

/** Send one replay entry with its stored wire metadata reattached. */
export function sendReplay(
  core: EngineCore,
  connection: RuntimeConnection,
  options: SendReplayOptions,
): void {
  const { channelName, channelFamily, event, payload, wire } = options;
  assertPayload(event, payload);

  const resolvedChannel = channelName ?? wire.channel ?? null;
  const livething: Record<string, unknown> = {
    deliverySeq: wire.deliverySeq,
    messageId: wire.messageId,
  };

  if (resolvedChannel !== null) livething.channel = resolvedChannel;
  if (channelFamily !== null) livething.channelFamily = channelFamily;

  let frame: string;
  try {
    const payloadJson = serializePayload(event, payload);
    frame = serializeWireFrame(event, JSON.parse(payloadJson), livething);
    // A stored row over the send limit would throw on every replay and hold back the rows
    // after it, so it is replaced like a row that cannot be serialized.
    const { sendBytes } = core.messageLimits;
    if (textOverLimit(frame, sendBytes)) {
      throw new Error(`[livething] The replay frame is over the send limit of ${sendBytes} bytes.`);
    }
  } catch (error) {
    core.logger.error('[livething] Could not send a replay frame; sending fallback __error__', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      frame = serializeWireFrame('__error__', { code: InternalError.code }, livething);
    } catch (fallbackError) {
      core.logger.error('[livething] Fallback __error__ frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }

  connection.descriptor.send({ kind: 'text', text: frame });
}
