import type { PrimitiveHelpers } from '~/internal/runtime.ts';

/** Mints unique ids for one socket: `<scope>-<n>`, or `<prefix>-<scope>-<n>`. */
export type IdGenerator = (prefix?: string) => string;

const ID_GENERATOR_KEY = 'id';

/**
 * The id generator for a socket, created on first use and cached in the socket's
 * `shared` registry so every primitive shares one counter (ids never collide).
 * Only primitives that mint ids — requests, streams, channels, inbox — pull this
 * in, so a bare send/receive socket ships none of it.
 */
export function idGenerator(helpers: PrimitiveHelpers): IdGenerator {
  const existing = helpers.shared.get(ID_GENERATOR_KEY) as IdGenerator | undefined;
  if (existing) return existing;

  const generate = createIdGenerator();
  helpers.shared.set(ID_GENERATOR_KEY, generate);

  return generate;
}

function createIdGenerator(): IdGenerator {
  const scope = makeIdScope();
  let counter = 0;

  return (prefix) => {
    const id = ++counter;
    return prefix ? `${prefix}-${scope}-${id}` : `${scope}-${id}`;
  };
}

/**
 * A unique per-socket token mixed into every generated id. `randomUUID` is ideal;
 * when it's missing (older runtimes) fall back to 16 bytes from `getRandomValues`,
 * which is just as collision-resistant — crucially it does NOT share a seeded
 * counter the way a weak RNG might, so two fresh sockets can't mint the same
 * token. Only with no secure RNG at all does it drop to `Math.random`.
 */
function makeIdScope(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();

  if (crypto?.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  return Math.random().toString(36).slice(2, 10);
}
