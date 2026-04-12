/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * The function signature for an incoming event handler.
 *
 * @param ctx     The handler context for the current connection.
 * @param payload The validated inbound payload.
 */
export type IncomingHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => void | Promise<void>;

/**
 * The primitive type produced by `incoming()`. Carries the event name, handler,
 * and optional validator so the engine can dispatch and validate messages at
 * runtime, and so the type generator can add the event to the client's event map.
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
  /**
   * Optional schema validator. When present, the engine validates the raw
   * payload before calling `handler`. If validation fails, `onValidationError`
   * fires instead.
   */
  readonly validator?: Validator<TPayload>;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const INCOMING_KEY = Symbol('incoming');

/**
 * Creates an incoming event handler primitive. The engine calls `handler` every
 * time the client sends an event whose name matches `event`.
 *
 * If `options.validator` is provided, the engine validates the raw payload first.
 * A validation failure triggers `onValidationError` and the handler is not called.
 *
 * In practice you rarely call `incoming()` directly. Use it through the builder:
 * `server('name').incoming(myContract, handler)` — that method calls this
 * factory internally.
 *
 * @param event   The event name to listen for.
 * @param handler The function to call with the validated payload.
 * @param options.validator Optional schema validator for the payload.
 *
 * @example
 * ```ts
 * const SendMessage = event('send-message', z.object({ text: z.string() }));
 *
 * server('chat').incoming(SendMessage, async (ctx, payload) => {
 *   await saveMessage(payload.text);
 * });
 * ```
 */
export function incoming<TEvent extends string, TPayload, TCtx = any>(
  event: TEvent,
  handler: IncomingHandler<TCtx, TPayload>,
  options?: { validator?: Validator<TPayload> },
): IncomingPrimitive<TEvent, TPayload, TCtx> {
  return {
    __wskit: 'incoming',
    __kind: 'handler',
    __identity: [INCOMING_KEY, event],
    __dependencies: [],
    __requires: {},
    event,
    handler,
    validator: options?.validator,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
incoming.__key = INCOMING_KEY;
