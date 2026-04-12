import type { Primitive } from '~/primitive.ts';

export interface ServerDefinition<TPrimitives extends readonly Primitive[] = readonly Primitive[]> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
}
