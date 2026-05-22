import { describe, expectTypeOf, it } from 'vitest';
import type { NamespaceClient } from './handler.ts';

describe('namespace client inference', () => {
  it('exposes the expected top-level slots', () => {
    expectTypeOf<NamespaceClient>().toHaveProperty('incoming');
    expectTypeOf<NamespaceClient>().toHaveProperty('outgoing');
    expectTypeOf<NamespaceClient>().toHaveProperty('requests');
    expectTypeOf<NamespaceClient>().toHaveProperty('streams');
    expectTypeOf<NamespaceClient>().toHaveProperty('namespaces');
    expectTypeOf<NamespaceClient>().toHaveProperty('channels');
  });
});

describe('NamespaceClient — InferClient precision pin', () => {
  it('every inferred client slot is a precise type, never `any`', () => {
    // Regression guard for the InferClient any-collapse bug: implement().build()
    // must carry the contract type. If build() returns `any` again, every slot
    // below collapses to `any` and these assertions fail to compile.
    expectTypeOf<NamespaceClient['incoming']>().not.toBeAny();
    expectTypeOf<NamespaceClient['outgoing']>().not.toBeAny();
    expectTypeOf<NamespaceClient['requests']>().not.toBeAny();
    expectTypeOf<NamespaceClient['streams']>().not.toBeAny();
    expectTypeOf<NamespaceClient['channels']>().not.toBeAny();
    expectTypeOf<NamespaceClient['namespaces']>().not.toBeAny();
    expectTypeOf<NamespaceClient['__errors__']>().not.toBeAny();
  });
});
