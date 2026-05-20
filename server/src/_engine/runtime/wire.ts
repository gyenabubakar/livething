import { InternalError } from '@wskit/core';
import { PROTOCOL_PAYLOAD_FIELDS } from '~/_engine/compile/utils.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Send an internal protocol message. Skips outgoing validation and decoration.
 *
 * If a payload field can't be JSON-serialized (BigInt, circular, function,
 * symbol), log it and send a sanitized `_error` frame instead so the client
 * can still correlate the request or stream.
 */
export function sendProtocolMessage(
  core: EngineCore,
  connection: RuntimeConnection,
  event: string,
  payload: Record<string, unknown>,
): void {
  let wire: string;
  try {
    wire = JSON.stringify({ event, payload });
  } catch (error) {
    core.logger.error('[wskit] Failed to serialize protocol frame; sending fallback _error', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackPayload: Record<string, unknown> = { code: InternalError.code };
    for (const key of PROTOCOL_PAYLOAD_FIELDS) {
      if (key in payload) fallbackPayload[key] = payload[key];
    }
    try {
      wire = JSON.stringify({ event: '_error', payload: fallbackPayload });
    } catch (fallbackError) {
      core.logger.error('[wskit] Fallback _error frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }
  connection.descriptor.send(wire);
}

/** Send one replay entry with its stored wire metadata reattached. */
export function sendReplay(
  core: EngineCore,
  connection: RuntimeConnection,
  channelName: string | null,
  channelScope: string | null,
  event: string,
  payload: unknown,
  wire: { seq: number; messageId: string; channel?: string },
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }

  const finalPayload: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    _seq: wire.seq,
    _messageId: wire.messageId,
  };

  const resolvedChannel = channelName ?? wire.channel ?? null;
  if (resolvedChannel !== null) finalPayload._channel = resolvedChannel;
  if (channelScope !== null) finalPayload._channelScope = channelScope;

  let frame: string;
  try {
    frame = JSON.stringify({ event, payload: finalPayload });
  } catch (error) {
    core.logger.error('[wskit] Failed to serialize replay frame; sending fallback _error', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackPayload: Record<string, unknown> = { code: InternalError.code };
    for (const key of PROTOCOL_PAYLOAD_FIELDS) {
      if (key in finalPayload) fallbackPayload[key] = finalPayload[key];
    }
    try {
      frame = JSON.stringify({ event: '_error', payload: fallbackPayload });
    } catch (fallbackError) {
      core.logger.error('[wskit] Fallback _error frame also failed to serialize; dropping', {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return;
    }
  }
  connection.descriptor.send(frame);
}
