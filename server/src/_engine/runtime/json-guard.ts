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
 * The payload rule: what LiveThing sends must be an object or `null` in JSON. These checks live in this
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
    `[livething] The payload for "${event}" must be a plain object, such as { text: 'hi' }, or ` +
      `null, but it was ${got}. A stream chunk is a payload too, so yield an object or null.`,
  );
}

function durableChunkError(event: string, got: string): Error {
  return new Error(
    `[livething] A chunk of "${event}" must have a JSON value, such as { text: 'hi' }, 42 or ` +
      `'hi', but it was ${got}.`,
  );
}

const ITERABLE_GOT = 'an iterable such as a Map or a Set, which JSON turns into {}';

/**
 * An iterable such as a `Map`, a `Set` or an async generator becomes `{}` in JSON and loses its
 * data, so it is refused, unless its own `toJSON()` decides what is sent.
 */
function isIterableWithoutToJSON(value: object): boolean {
  const candidate = value as {
    [Symbol.iterator]?: unknown;
    [Symbol.asyncIterator]?: unknown;
    toJSON?: unknown;
  };
  const iterable =
    typeof candidate[Symbol.iterator] === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function';
  // A boxed String is iterable too, but JSON unboxes it to its string.
  return iterable && typeof candidate.toJSON !== 'function' && !(value instanceof String);
}

/**
 * The checks that can run before serializing, without calling `toJSON()`: a primitive, a
 * function, an array and an iterable without `toJSON()` are refused, and `null` passes.
 * `serializePayload` checks the rest on the JSON text.
 */
export function assertPayload(
  event: string,
  payload: unknown,
): asserts payload is Record<string, unknown> | null {
  if (payload === null) return;

  if (typeof payload !== 'object') throw payloadError(event, typeof payload);

  if (Array.isArray(payload)) throw payloadError(event, 'an array');

  if (isIterableWithoutToJSON(payload)) {
    throw payloadError(event, ITERABLE_GOT);
  }
}

/**
 * `JSON.stringify` once, and the value it serialized at the root: what `toJSON()` returned, if
 * the value has one. JSON does not call `toJSON()` on that result, so an iterable there would
 * become `{}`. Only a value with a `toJSON()` pays for the replacer that reads the root.
 */
function stringifyReadingRoot(value: unknown): { json: string | undefined; root: unknown } {
  const toJSON = (value as { toJSON?: unknown } | null | undefined)?.toJSON;
  if (typeof toJSON !== 'function') return { json: JSON.stringify(value), root: value };

  let root: unknown;
  let rootSeen = false;
  const json = JSON.stringify(value, (_key, item: unknown) => {
    // The replacer sees the root first, under the key "".
    if (!rootSeen) {
      rootSeen = true;
      root = item;
    }

    return item;
  });

  return { json, root };
}

/** Whether what `toJSON()` returned is an iterable (not an array) that JSON turns into `{}`. */
function toJsonGaveIterable(value: unknown, root: unknown): boolean {
  if (root === value || typeof root !== 'object' || root === null || Array.isArray(root)) {
    return false;
  }

  const candidate = root as { [Symbol.iterator]?: unknown; [Symbol.asyncIterator]?: unknown };
  const iterable =
    typeof candidate[Symbol.iterator] === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function';
  return iterable && !(root instanceof String);
}

/** Serialize a payload once, and require the JSON to be an object or `null`. */
export function serializePayload(event: string, payload: unknown): string {
  assertPayload(event, payload);
  if (payload === null) return 'null';

  const { json, root } = stringifyReadingRoot(payload);
  if (json === undefined) {
    throw new Error(
      `[livething] Outgoing payload for "${event}" did not serialize to JSON. ` +
        `A toJSON() method that returns undefined is the usual cause.`,
    );
  }

  if (toJsonGaveIterable(payload, root)) throw payloadError(event, ITERABLE_GOT);

  if (!json.startsWith('{')) {
    throw payloadError(
      event,
      `an object that JSON turned into ${json.slice(0, 40)} (a Date, a boxed value, or a toJSON() that does not return an object)`,
    );
  }

  return json;
}

/**
 * The JSON of one recorded stream chunk: an object chunk as its own JSON, and any other
 * chunk (a primitive, `null`, an array, a `Date`) wrapped as `{ "value": ... }`. It is built
 * from one `JSON.stringify` call. A chunk with no JSON (a function without `toJSON()`, or
 * `undefined`) and an iterable without `toJSON()` (a `Map`) are refused.
 */
export function serializeDurableChunk(event: string, chunk: unknown): string {
  const isObjectLike = (typeof chunk === 'object' && chunk !== null) || typeof chunk === 'function';
  if (isObjectLike && !Array.isArray(chunk) && isIterableWithoutToJSON(chunk)) {
    throw durableChunkError(event, ITERABLE_GOT);
  }

  // A function without toJSON(), a symbol, or undefined, has no JSON at all.
  const { json, root } = stringifyReadingRoot(chunk);
  if (json === undefined) {
    throw durableChunkError(event, `${typeof chunk}, which has no JSON`);
  }

  if (toJsonGaveIterable(chunk, root)) throw durableChunkError(event, ITERABLE_GOT);

  return json.startsWith('{') ? json : `{"value":${json}}`;
}
