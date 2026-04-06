/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { IncomingHandler } from '~/incoming/incoming.ts';
import type { PostInterceptHandler, PreInterceptHandler } from '~/intercept/intercept.ts';
import type { Validator } from '~/types.ts';

/**
 * A tiny wrapper around a callback.
 *
 * This exists to give TypeScript a simpler place to apply contextual
 * typing. In plain words: wrapping the callback in `h(...)` helps the
 * editor understand `ctx` and `payload` inside `incoming`, `request`,
 * and `intercept`.
 */
export interface Handled<
  TFn extends (...args: any[]) => any = (...args: any[]) => any,
  TPayload = unknown,
> {
  readonly __wskit: 'h';
  readonly fn: TFn;
  readonly validator?: Validator<TPayload>;
}

/**
 * Wrap a callback so wskit can type it more reliably.
 *
 * This is a TypeScript workaround. It does not change runtime behavior.
 *
 * ```ts
 * incoming('send-message', h(async (ctx, payload) => {
 *   ctx.send('message', { text: payload.text });
 * }, {
 *   validator: (value: unknown) => value as { text: string }
 * }))
 * ```
 */
export function h<TCtx, TPayload>(
  fn: IncomingHandler<TCtx, TPayload>,
): Handled<IncomingHandler<TCtx, TPayload>, TPayload>;
export function h<TCtx, TPayload>(
  fn: IncomingHandler<TCtx, TPayload>,
  options: { validator: (value: unknown) => TPayload },
): Handled<IncomingHandler<TCtx, TPayload>, TPayload>;
export function h<TCtx, TSchema extends StandardSchemaV1>(
  fn: IncomingHandler<TCtx, StandardSchemaV1.InferOutput<TSchema>>,
  options: { validator: TSchema },
): Handled<
  IncomingHandler<TCtx, StandardSchemaV1.InferOutput<TSchema>>,
  StandardSchemaV1.InferOutput<TSchema>
>;
export function h<TCtx>(fn: PreInterceptHandler<TCtx>): Handled<PreInterceptHandler<TCtx>>;
export function h<TCtx, TPayload>(
  fn: PostInterceptHandler<TCtx, TPayload>,
): Handled<PostInterceptHandler<TCtx, TPayload>>;
export function h<TFn extends (...args: any[]) => any>(fn: TFn): Handled<TFn>;
export function h<TFn extends (...args: any[]) => any>(
  fn: TFn,
  options?: { validator?: Validator },
): Handled<TFn> {
  return { __wskit: 'h', fn, validator: options?.validator };
}

/**
 * Check whether a value is a callback wrapped with `h(...)`.
 */
export function isHandled<TFn extends (...args: any[]) => any>(
  value: TFn | Handled<TFn>,
): value is Handled<TFn> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__wskit' in value &&
    value.__wskit === 'h' &&
    'fn' in value
  );
}

/**
 * Read the real callback out of either a raw function or `h(...)`.
 */
export function unwrapHandled<TFn extends (...args: any[]) => any>(value: TFn | Handled<TFn>): TFn {
  return isHandled(value) ? value.fn : value;
}
