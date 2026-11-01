/**
 * Marker carrying a phantom type so typed payload and metadata definitions flow
 * into the contract without any runtime cost.
 */
export interface TypeMarker<T> {
  readonly __livething_t: 't';
  readonly _phantom?: T;
}

export { error } from '@livething/core';

/**
 * Type-only carrier used to declare a shape with no runtime schema, such as the
 * payload of an `emits(...)` event.
 *
 * @example
 * ```ts
 * server({ capabilities: [emits({ 'chat-message': t<{ text: string }>() })] });
 * ```
 */
export function t<T>(): TypeMarker<T> {
  return { __livething_t: 't' };
}
