/* oxlint-disable @typescript-eslint/no-explicit-any */
import { dedup } from '~/primitives/dedup.ts';
import { definePrimitive } from '~/primitives/define.ts';
import { sequence } from '~/primitives/sequence.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { ReplayWire } from '~/types/scope-state.ts';

export type ReplayHandler<TCtx = any> = (ctx: TCtx, since: number) => void | Promise<void>;

export interface ReplayOptions<TCtx = any> {
  readonly onReplay?: ReplayHandler<TCtx>;
}

/**
 * The primitive instance returned by `replay()`.
 *
 * `defineServer()` and `channel()` use this to decide whether `ctx.sendReplay()`
 * exists later in the same scope.
 */
export interface ReplayPrimitive<TCtx = any> extends Primitive<'replay'> {
  readonly onReplay?: ReplayHandler<TCtx>;
}

export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

const REPLAY_KEY = Symbol('replay');

const _replay = definePrimitive<
  'replay',
  [options?: ReplayOptions],
  {
    onReplay?: ReplayHandler;
  }
>({
  tag: 'replay' as const,
  key: REPLAY_KEY,
  kind: 'infrastructure' as const,
  dependencies: [sequence, dedup],
  requires: {
    storage: true,
  },
  create(options?: ReplayOptions) {
    return {
      onReplay: options?.onReplay,
    };
  },
});

/**
 * Turn on replay support for the current scope.
 */
export function replay<TCtx>(options?: ReplayOptions<TCtx>): ReplayPrimitive<TCtx>;
export function replay(options?: ReplayOptions<any>): ReplayPrimitive<any>;
export function replay(options?: ReplayOptions<any>): ReplayPrimitive<any> {
  return _replay(options) as ReplayPrimitive<any>;
}

/** Dependency ref — use in `dependencies: [replay]` to assert it's registered. */
replay.__key = REPLAY_KEY;
