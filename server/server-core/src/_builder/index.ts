/**
 * Public surface of the builder module.
 *
 * - `server` — entry point for defining a new wskit server
 * - `ServerBuilder` — the fluent builder class (useful for type-level work,
 *   e.g. side-effect imports that augment the class)
 * - `GroupBuilder` — the sub-builder returned by `ServerBuilder.group()`
 * - `GroupPrimitive` — the type returned by `GroupBuilder.extract()`
 */
export { server, ServerBuilder, GroupBuilder } from './server-builder.ts';
export type { GroupPrimitive } from './server-builder.ts';
