/** Marker wrapper for `ctx.stream.withCursor(chunk, cursor)` yields. */

const CURSOR_MARK = Symbol('livething:cursor');

/**
 * Internal envelope produced by `ctx.stream.withCursor(chunk, cursor)` so the
 * resumable-stream runtime can split the chunk from the cursor before sending.
 */
export interface CursorChunk<TChunk = unknown, TCursor = unknown> {
  readonly [CURSOR_MARK]: true;
  readonly chunk: TChunk;
  readonly cursor: TCursor;
}

/** True when `value` was produced by `makeCursorChunk` / `ctx.stream.withCursor`. */
export function isCursorChunk(value: unknown): value is CursorChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CURSOR_MARK] === true
  );
}

/** Wrap a chunk with the cursor value to persist alongside it. */
export function makeCursorChunk<TChunk, TCursor>(
  chunk: TChunk,
  cursor: TCursor,
): CursorChunk<TChunk, TCursor> {
  return { [CURSOR_MARK]: true, chunk, cursor };
}
