/**
 * Cursor marker used by the resumable stream runtime.
 *
 * A user generator yields chunks paired with a cursor via
 * `ctx.stream.withCursor(chunk, cursor)`. That helper wraps the chunk in
 * `CursorChunk`, which the runtime unwraps before sending to the wire and
 * persists the cursor so a future resume can pick up from there.
 */

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
