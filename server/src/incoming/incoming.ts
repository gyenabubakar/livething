/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  assertValidLiveThingIdentifier,
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  LiveThingConfigError,
} from '@livething/core';
import { assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

interface IncomingOptions<TPayload> {
  validator?: Validator<TPayload>;
  allowInterleaving?: boolean;
  /** Set by `base.binary.on(...)`: the handler takes binary frames, not text ones. */
  binary?: boolean;
  /** The most bytes a binary frame for this handler may carry. */
  maxBytes?: number;
}

/**
 * Handler function for a client→server event. A binary handler also gets the frame's
 * bytes, as a plain `Uint8Array` view.
 */
export type IncomingHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
  bytes?: Uint8Array,
) => void | Promise<void>;

/**
 * Primitive behind `base.on(...)` and `base.binary.on(...)`. Carries the event name,
 * handler, and optional validator so the engine can dispatch and validate messages.
 */
export interface IncomingPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'incoming'> {
  /** The event name the client must send to trigger this handler. */
  readonly event: TEvent;
  /** The function to call when the event is received. */
  readonly handler: IncomingHandler<TCtx, TPayload>;
  /** Whether this handler may start without waiting for prior app work. */
  readonly allowInterleaving: boolean;
  /**
   * Optional schema validator. When present, the engine validates the raw
   * payload before calling `handler`. If validation fails, `onError` gets a
   * `ValidationFailed` error instead.
   */
  readonly validator?: Validator<TPayload>;
  /** `true` for a `base.binary.on(...)` handler, which takes only binary frames. */
  readonly binary?: boolean;
  /** The most bytes a binary frame may carry for this handler. Absent: no limit of its own. */
  readonly maxBytes?: number;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const INCOMING_KEY = Symbol('incoming');

/**
 * Internal primitive factory. The user-facing surface for declaring a
 * client→server event is `base.on(...)` (or `base.binary.on(...)`), which calls this
 * factory with the event name and its handler.
 */
export function incoming<TEvent extends string, TPayload, TCtx = any>(
  event: TEvent,
  handler: IncomingHandler<TCtx, TPayload>,
  options?: IncomingOptions<TPayload>,
): IncomingPrimitive<TEvent, TPayload, TCtx> {
  assertValidLiveThingIdentifier(event, 'incoming() event name');
  const method = options?.binary ? 'binary.on' : 'on';
  if (typeof handler !== 'function') {
    throw new Error(`[livething] ${method}('${event}'): 'run' must be a function.`);
  }

  const primitive: IncomingPrimitive<TEvent, TPayload, TCtx> = {
    __livething: 'incoming',
    __identity: [INCOMING_KEY, event],
    __requires: {},
    event,
    handler,
    allowInterleaving: options?.allowInterleaving ?? false,
    validator: options?.validator,
  };

  if (!options?.binary) return primitive;

  const maxBytes = options.maxBytes;
  assertOptionalPositiveInteger(maxBytes, 'maxBytes', `binary.on('${event}')`);

  return {
    ...primitive,
    binary: true,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    __validate(view) {
      if (maxBytes === undefined) return;

      const room = binaryBytesRoom(view.receiveBytes);
      if (room <= 0) {
        throw new LiveThingConfigError(
          `binary.on('${event}'): maxBytes cannot fit, because the adapter's receive limit ` +
            `of ${view.receiveBytes} bytes is under 64 KiB plus the ${BINARY_HEADER_LENGTH}-byte ` +
            `header, the room a binary frame's info may take. To set maxBytes, raise the ` +
            `adapter's message limit above ${BINARY_HEADER_LENGTH + BINARY_ENVELOPE_LIMIT} bytes.`,
        );
      }

      if (maxBytes > room) {
        throw new LiveThingConfigError(
          `binary.on('${event}'): maxBytes ${maxBytes} does not fit in the adapter's receive ` +
            `limit of ${view.receiveBytes} bytes, with the ${BINARY_HEADER_LENGTH}-byte header ` +
            `and room for a 64 KiB envelope. Use ${room} or less, or leave maxBytes out.`,
        );
      }
    },
  };
}

/**
 * The most bytes a binary frame can always carry: the receive limit, less the header and
 * the largest envelope, because the info may fill all 64 KiB of it. It is the default
 * `maxBytes`, and the most an explicit one may be. `0` or less when the limit is too small.
 */
export function binaryBytesRoom(receiveBytes: number): number {
  return receiveBytes - BINARY_HEADER_LENGTH - BINARY_ENVELOPE_LIMIT;
}
