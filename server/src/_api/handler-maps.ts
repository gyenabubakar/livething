/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ChannelImplement } from '~/channel/implement.ts';
import type { NamespaceImplement } from '~/namespace/implement.ts';
import type { Primitive } from '~/primitive.ts';
import type { Definition } from './definitions.ts';

// All the handlers and sub-builders the build phase needs to walk a list of
// definitions. One bag is built per scope — top-level, or one per nested
// channel / namespace.
export interface HandlerMaps {
  readonly incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  readonly requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  readonly streamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  readonly resumableStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  readonly recordedStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  readonly scheduledHandlers: Map<string, (ctx: any, data: any) => void | Promise<void>>;
  readonly channelImpls: Map<string, ChannelImplement<any, any>>;
  readonly namespaceImpls: Map<string, NamespaceImplement<any, any>>;
}

// The dispatcher, passed into channel/namespace compile so they can walk
// their own child definitions without importing the dispatcher directly
// (which would be a circular import).
export type BuildDefinitionsFn = (
  definitions: readonly Definition[],
  handlers: HandlerMaps,
) => Primitive[];

/**
 * Map.set that refuses to overwrite. A second registration of the same key
 * means two callers raced for one handler slot — the silent winner would
 * leave the other handler dead and the failure unobservable. Throw instead
 * so the dev knows exactly where the conflict is.
 */
export function setOnce<K, V>(map: Map<K, V>, key: K, value: V, kind: string, where: string): void {
  if (map.has(key)) {
    throw new Error(
      `[wskit] Duplicate ${kind} handler for '${String(key)}' in ${where}. ` +
        `An event can only be bound once — drop the duplicate or merge the two handlers.`,
    );
  }
  map.set(key, value);
}
