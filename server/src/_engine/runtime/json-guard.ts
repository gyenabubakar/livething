/**
 * Serialize a value with JSON.stringify and confirm the result is actually a
 * string. `JSON.stringify` returns the JS value `undefined` (not a string)
 * when the input ultimately serializes to nothing — most commonly an object
 * whose `toJSON()` returns `undefined`. Without this guard the bad value
 * silently reaches the wire (frame splice produces literal `undefined` text)
 * or storage (column gets bound as JS `undefined`, which either fails the
 * SQL or writes garbage).
 *
 * Throws a clear `[livething]` error naming the field and context so a missing
 * `toJSON` return value points the dev at their own code instead of a
 * downstream parse failure.
 */
export function serializeJsonOrThrow(value: unknown, context: string): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new Error(
      `[livething] ${context} did not serialize to JSON. ` +
        `A toJSON() method that returns undefined is the usual cause.`,
    );
  }

  return json;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What JSON writes for a value: the result of its `toJSON()` when it has one (a `Date` gives a
 * string, an ORM record gives an object), else the value itself.
 */
export function jsonShapeOf(value: unknown): unknown {
  const toJSON = (value as { toJSON?: unknown } | null | undefined)?.toJSON;
  return typeof toJSON === 'function' ? toJSON.call(value) : value;
}

/** Whether a value stays an object in JSON, the `PayloadObject` rule at runtime. */
export function isPayloadObject(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && isJsonObject(jsonShapeOf(value));
}

/**
 * Throw unless the payload stays an object in JSON — `null`, primitives, arrays, functions and
 * objects whose `toJSON()` gives something else (a `Date` gives a string) are rejected. A stream
 * chunk is a payload too, so a generator that yields `null` lands here.
 *
 * It lives in this module, which imports nothing, because the send path and durable streams both
 * use it: importing it from `outgoing/runtime.ts` into stream code made an import cycle that left
 * functions undefined in the Cloudflare bundle.
 */
export function assertPayloadRecord(
  event: string,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (isPayloadObject(payload)) return;

  let got: string = typeof payload;
  if (payload === null) got = 'null';
  if (Array.isArray(payload)) got = 'an array';
  if (isJsonObject(payload)) {
    got =
      'an object whose toJSON() does not return an object, such as a Date, which JSON turns into a string';
  }

  throw new Error(
    `[livething] The payload for "${event}" must be a plain object, such as { text: 'hi' }, ` +
      `but it was ${got}. A stream chunk is a payload too, so yield an object.`,
  );
}

/** Parse a nullable JSON storage value, recovering to undefined when it is invalid. */
export function parseJsonOrUndefined(value: string | null): unknown {
  if (value === null) return undefined;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
