/**
 * Public surface of the builder module.
 *
 * - `server` — entry point for defining a new wskit server
 * - `ServerBuilder` — the fluent builder class (mainly useful if you are
 *   extending the builder API or importing modules that augment it)
 * - `GroupBuilder` — the sub-builder used inside `.group()` callbacks
 */
export { server, ServerBuilder, GroupBuilder } from './server-builder.ts';
export type { GroupPrimitive } from './server-builder.ts';
