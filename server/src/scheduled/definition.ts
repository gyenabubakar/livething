/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a scheduled task. Produced by the `scheduled({...})`
 * capability; the matching body is bound via
 * `base.scheduled(id, { run(ctx, data) { ... } })`.
 */
export interface ScheduledDef<TId extends string = string, TData = unknown> {
  readonly _: 'scheduled';
  readonly id: TId;
  readonly data?: Validator<TData>;
  readonly retry?: boolean | readonly number[];
  readonly every?: number;
}

/**
 * Declare a scheduled task. Bind its body via
 * `base.scheduled(id, { run(ctx, data) { ... } })`.
 */
export function scheduled<TId extends string, TData = unknown>(
  id: TId,
  config?: {
    data?: Validator<TData>;
    retry?: boolean | readonly number[];
    every?: number;
  },
): ScheduledDef<TId, TData> {
  return {
    _: 'scheduled',
    id,
    data: config?.data,
    retry: config?.retry,
    every: config?.every,
  };
}
