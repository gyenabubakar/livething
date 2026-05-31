/**
 * Serialize a value with JSON.stringify and confirm the result is actually a
 * string. `JSON.stringify` returns the JS value `undefined` (not a string)
 * when the input ultimately serializes to nothing — most commonly an object
 * whose `toJSON()` returns `undefined`. Without this guard the bad value
 * silently reaches the wire (frame splice produces literal `undefined` text)
 * or storage (column gets bound as JS `undefined`, which either fails the
 * SQL or writes garbage).
 *
 * Throws a clear `[wskit]` error naming the field and context so a missing
 * `toJSON` return value points the dev at their own code instead of a
 * downstream parse failure.
 */
export function serializeJsonOrThrow(value: unknown, context: string): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new Error(
      `[wskit] ${context} did not serialize to JSON. ` +
        `A toJSON() method that returns undefined is the usual cause.`,
    );
  }
  return json;
}
