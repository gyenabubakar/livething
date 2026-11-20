import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { WireAwareness } from '~/doc/wire.ts';
import type { DocDef } from '~/schema.ts';

const MAX_LOCKS = 32;
const MAX_LOCK_KEY = 128;
const encoder = new TextEncoder();

/** The bytes a key takes in the JSON a client sends, without its quotes. */
function wireBytes(key: string): number {
  return encoder.encode(JSON.stringify(key)).length - 2;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function issue(message: string): StandardSchemaV1.FailureResult {
  return { issues: [{ message }] };
}

/**
 * The shape of every member's awareness state on the wire. The app's own part (`user`) is
 * checked by the doc type's schema in {@link checkAwareness}, which knows the doc type.
 */
export const wireAwareness: StandardSchemaV1<WireAwareness, WireAwareness> = {
  '~standard': {
    version: 1,
    vendor: 'livething',
    validate(value) {
      if (!isPlainObject(value)) return issue('awareness must be an object');

      const { user, yjs, editor, locks } = value;
      if (!Number.isInteger(yjs) || (yjs as number) < 0) return issue('yjs must be a client ID');

      if (editor !== null && !isPlainObject(editor)) {
        return issue('editor must be an object or null');
      }

      if (
        !Array.isArray(locks) ||
        locks.length > MAX_LOCKS ||
        locks.some(
          (key) => typeof key !== 'string' || key === '' || wireBytes(key) > MAX_LOCK_KEY,
        ) ||
        new Set(locks).size !== locks.length
      ) {
        return issue(
          `locks must be up to ${MAX_LOCKS} different keys of 1 to ${MAX_LOCK_KEY} bytes`,
        );
      }

      return {
        value: {
          user: user ?? null,
          yjs: yjs as number,
          editor: (editor ?? null) as WireAwareness['editor'],
          locks: locks as string[],
        },
      };
    },
  },
};

/** What the awareness check needs to know about the member and the room. */
export interface AwarenessCheckInput {
  readonly def: DocDef | undefined;
  /** Whether the member may edit the doc. */
  readonly canEdit: boolean;
  readonly state: WireAwareness;
  readonly previous: WireAwareness | null;
  /** The other members' states. */
  readonly others: readonly WireAwareness[];
}

/**
 * Whether to take a member's new awareness state: its own part passes the doc type's schema
 * (synchronously), and each lock it newly holds is held by nobody else. A member who may only
 * view the doc can't hold locks.
 */
export function checkAwareness(input: AwarenessCheckInput): boolean {
  const { def, canEdit, state, previous, others } = input;
  if (!def) return false;

  // `null` is a member that has set no app state yet.
  if (def.awareness && state.user !== null) {
    const result = def.awareness['~standard'].validate(state.user);
    if (result instanceof Promise) {
      result.catch(() => {});
      return false;
    }

    if (result.issues) return false;
  } else if (state.user !== null) {
    return false;
  }

  const held = new Set(previous?.locks ?? []);
  const fresh = state.locks.filter((key) => !held.has(key));
  if (fresh.length === 0) return true;

  if (!canEdit) return false;

  return fresh.every((key) => others.every((other) => !other.locks.includes(key)));
}
