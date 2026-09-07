import { InternalError } from '@wskit/core';
import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

export interface SendProtocolMessageOptions {
  event: string;
  payload: Record<string, unknown>;
  wskit: Record<string, unknown>;
}

/**
 * Send an internal protocol frame. Skips outgoing validation and decoration.
 *
 * The frame is `{ event, payload, __wskit }` — `payload` is the protocol
 * event's own data, `__wskit` is its routing/correlation metadata. If the
 * frame can't be JSON-serialized (BigInt, circular, function, symbol), log it
 * and send a sanitized `__error__` frame instead so the client can still
 * correlate the request or stream.
 */
export function sendProtocolMessage(
  core: EngineCore,
  connection: RuntimeConnection,
  options: SendProtocolMessageOptions,
): void {
  const { event, payload, wskit } = options;
  let wire: string;
  try {
    wire = JSON.stringify({ event, payload, __wskit: wskit });
  } catch (error) {
    core.logger.error('[wskit] Failed to serialize protocol frame; sending fallback __error__', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      wire = JSON.stringify({
        event: '__error__',
        payload: { code: InternalError.code },
        __wskit: wskit,
      });
    } catch (fallbackError) {
      core.logger.error('[wskit] Fallback __error__ frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }

  connection.descriptor.send(wire);
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
  const wskit: Record<string, unknown> = {};
  if (channelName !== null) wskit.channel = channelName;
  if (channelFamily !== null) wskit.channelFamily = channelFamily;

  sendProtocolMessage(core, connection, {
    event: '__gap__',
    payload: { missedThrough },
    wskit,
  });
}

export interface SendReplayOptions {
  channelName: string | null;

  channelFamily: string | null;

  event: string;

  payload: unknown;

  wire: { seq: number; messageId: string; channel?: string };
}

/** Send one replay entry with its stored wire metadata reattached. */
export function sendReplay(
  core: EngineCore,
  connection: RuntimeConnection,
  options: SendReplayOptions,
): void {
  const { channelName, channelFamily, event, payload, wire } = options;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }

  const resolvedChannel = channelName ?? wire.channel ?? null;
  const wskit: Record<string, unknown> = {
    seq: wire.seq,
    messageId: wire.messageId,
  };

  if (resolvedChannel !== null) wskit.channel = resolvedChannel;
  if (channelFamily !== null) wskit.channelFamily = channelFamily;

  let frame: string;
  try {
    const payloadJson = serializeJsonOrThrow(payload, `Replay payload for "${event}"`);
    frame = `{"event":${JSON.stringify(event)},"payload":${payloadJson},"__wskit":${JSON.stringify(wskit)}}`;
  } catch (error) {
    core.logger.error('[wskit] Failed to serialize replay frame; sending fallback __error__', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      frame = JSON.stringify({
        event: '__error__',
        payload: { code: InternalError.code },
        __wskit: wskit,
      });
    } catch (fallbackError) {
      core.logger.error('[wskit] Fallback __error__ frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }

  connection.descriptor.send(frame);
}
