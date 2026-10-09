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

/*
 * The payload rule: what LiveThing sends must be an object in JSON. These checks live in this
 * module, which imports nothing, because the send path and durable streams both use them: an
 * import from `outgoing/runtime.ts` into stream code once made a cycle that left functions
 * undefined in the Cloudflare bundle.
 *
 * Only `JSON.stringify` calls a payload's `toJSON()`, once, and the rule is checked on its text.
 * Calling `toJSON()` separately could disagree with JSON: a second call can return something
 * else, JSON passes the root key `""`, and JSON unboxes `new Number(7)` to `7`.
 */

function payloadError(event: string, got: string): Error {
  return new Error(
    `[livething] The payload for "${event}" must be a plain object, such as { text: 'hi' }, ` +
      `but it was ${got}. A stream chunk is a payload too, so yield an object.`,
  );
}

/**
 * An iterable such as a `Map` or a `Set` becomes `{}` in JSON and loses its data, so it is
 * refused, unless its own `toJSON()` decides what is sent.
 */
function isIterableWithoutToJSON(value: object): boolean {
  const candidate = value as { [Symbol.iterator]?: unknown; toJSON?: unknown };
  return typeof candidate[Symbol.iterator] === 'function' && typeof candidate.toJSON !== 'function';
}

/**
 * The checks that can run before serializing, without calling `toJSON()`: `null`, a primitive,
 * a function, an array and an iterable without `toJSON()` are refused. `serializePayload` checks
 * the rest on the JSON text.
 */
export function assertPayloadRecord(
  event: string,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw payloadError(event, payload === null ? 'null' : typeof payload);
  }

  if (Array.isArray(payload)) throw payloadError(event, 'an array');

  if (isIterableWithoutToJSON(payload)) {
    throw payloadError(event, 'an iterable such as a Map or a Set, which JSON turns into {}');
  }
}

/** Serialize a payload once, and require the JSON to be an object. */
export function serializePayload(event: string, payload: unknown): string {
  assertPayloadRecord(event, payload);
  const json = serializeJsonOrThrow(payload, `Outgoing payload for "${event}"`);
  if (!json.startsWith('{')) {
    throw payloadError(
      event,
      `an object that JSON turned into ${json.slice(0, 40)} (a Date, a boxed value, or a toJSON() that does not return an object)`,
    );
  }

  return json;
}

/**
 * The JSON of one cursor or recorded stream chunk: an object chunk as its own JSON, and any other
 * chunk (a primitive, `null`, an array, a `Date`) wrapped as `{ "value": ... }`. It is built
 * from one `JSON.stringify` call. A chunk with no JSON (a function without `toJSON()`, or
 * `undefined`) and an iterable without `toJSON()` (a `Map`) are refused.
 */
export function serializeDurableChunk(event: string, chunk: unknown): string {
  const isObjectLike = (typeof chunk === 'object' && chunk !== null) || typeof chunk === 'function';
  if (isObjectLike && !Array.isArray(chunk) && isIterableWithoutToJSON(chunk)) {
    throw payloadError(event, 'an iterable such as a Map or a Set, which JSON turns into {}');
  }

  // A function without toJSON(), or undefined, has no JSON at all.
  const json = JSON.stringify(chunk) as string | undefined;
  if (json === undefined) {
    throw payloadError(event, `${typeof chunk}, which has no JSON`);
  }

  return json.startsWith('{') ? json : `{"value":${json}}`;
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
