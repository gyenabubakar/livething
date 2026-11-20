import { MAX_LABEL } from '~/doc/wire.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ReadVersionInfo, UpdateInfo } from '~/doc/wire.ts';

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

/** What is wrong with a version label, or `null` when it is fine. */
export function labelProblem(label: unknown): string | null {
  return typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL
    ? null
    : `a version label must be a string of 1 to ${MAX_LABEL} characters`;
}

/** The input of `save-version`. */
export const saveVersionInput = schema<{ label: string }>((value) => {
  const label = isRecord(value) ? value.label : undefined;
  const problem = labelProblem(label);
  return problem ? { problem } : { label: label as string };
});

/** The info of `read-version`. */
export const readVersionInfo = schema<ReadVersionInfo>((value) =>
  isRecord(value) && typeof value.id === 'string' && Number.isSafeInteger(value.n)
    ? { id: value.id, n: value.n as number }
    : { problem: 'expected { id, n }' },
);

/** The detail of a `version-not-found` error. */
export const versionDetail = schema<{ type: string; id: string; version: string }>((value) =>
  isRecord(value) &&
  typeof value.type === 'string' &&
  typeof value.id === 'string' &&
  typeof value.version === 'string'
    ? { type: value.type, id: value.id, version: value.version }
    : { problem: 'expected { type, id, version }' },
);

/** The detail of an error about one doc. */
export const docDetail = schema<{ type: string; id: string }>((value) =>
  isRecord(value) && typeof value.type === 'string' && typeof value.id === 'string'
    ? { type: value.type, id: value.id }
    : { problem: 'expected { type, id }' },
);
