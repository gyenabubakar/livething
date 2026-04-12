/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

export interface ServerContract {
  readonly incoming: Record<string, any>;
  readonly outgoing: Record<string, any>;
  readonly requests: Record<string, any>;
  readonly streams: Record<string, any>;
  readonly errors: Record<string, any>;
  readonly channels: Record<string, any>;
  readonly namespaces: Record<string, any>;
}

export interface ServerDefinition<
  TPrimitives extends readonly Primitive[] = readonly Primitive[],
  TContract extends ServerContract = ServerContract,
> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
  readonly __contract?: TContract;
}
