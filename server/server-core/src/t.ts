/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * @internal — will be replaced by StandardSchema in the builder pattern rewrite.
 * Kept temporarily because outgoing, stream, and scheduled primitives still
 * reference TypeMarker in their type signatures.
 */
export interface TypeMarker<out T> {
  readonly __type: T;
}

export function t<T>(): TypeMarker<T> {
  return undefined as any;
}
