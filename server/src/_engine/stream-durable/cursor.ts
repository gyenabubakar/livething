/** Marker wrapper for `ctx.stream.withCursor(chunk, cursor)` yields. */

export const CURSOR_MARK = Symbol('wskit:cursor');

export interface CursorChunk<TChunk = unknown, TCursor = unknown> {
  readonly [CURSOR_MARK]: true;
  readonly chunk: TChunk;
  readonly cursor: TCursor;
}

export function isCursorChunk(value: unknown): value is CursorChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CURSOR_MARK] === true
  );
}

export function makeCursorChunk<TChunk, TCursor>(
  chunk: TChunk,
  cursor: TCursor,
): CursorChunk<TChunk, TCursor> {
  return { [CURSOR_MARK]: true, chunk, cursor };
}
