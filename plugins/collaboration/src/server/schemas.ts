import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { UpdateInfo } from '~/doc/wire.ts';

/** A small Standard Schema: `check` gives the value, or a message saying what is wrong. */
export function schema<T>(
  check: (value: unknown) => T | { readonly problem: string },
): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'livething',
      validate(value) {
        const result = check(value);
        if (typeof result === 'object' && result !== null && 'problem' in result) {
          return { issues: [{ message: (result as { problem: string }).problem }] };
        }

        return { value: result as T };
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No info. */
export const nothing = schema<null>((value) =>
  value === null ? null : { problem: 'expected null' },
);

/** The info of a client's `update`. */
export const updateInfo = schema<UpdateInfo>((value) => {
  if (!isRecord(value) || !Number.isSafeInteger(value.n)) return { problem: 'expected { n }' };

  const part = value.part;
  if (part === undefined) return { n: value.n as number };

  if (
    !Array.isArray(part) ||
    part.length !== 2 ||
    !part.every((number) => Number.isSafeInteger(number)) ||
    part[0] < 0 ||
    part[0] >= part[1]
  ) {
    return { problem: 'part must be [index, count] with index < count' };
  }

  return { n: value.n as number, part: [part[0], part[1]] as const };
});

/** The detail of an error about one doc. */
export const docDetail = schema<{ type: string; id: string }>((value) =>
  isRecord(value) && typeof value.type === 'string' && typeof value.id === 'string'
    ? { type: value.type, id: value.id }
    : { problem: 'expected { type, id }' },
);
