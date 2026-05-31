/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level machinery behind `matches(contract, key, frame)` and
 * `unsafeCast(contract, key, frame)`.
 *
 * The key grammar is `[<@channel | #namespace>::]event` — kind is derivable
 * from the event lookup so it's not in the key. Given a contract `TContract`
 * and a key literal `TKey`, `FrameFor` parses the key, walks the contract,
 * and returns the narrowed `InterceptFrame` shape (event, payload, kind, and
 * a scope-aware routing record) that the user code can rely on inside a
 * matching branch.
 */

import type { InterceptFrame } from '~/intercept/intercept.ts';

/**
 * Parsed view of a path key — the runtime parses with the same shape.
 *
 * - `top` — no scope prefix; the event lives at the contract's top level.
 * - `channel` — `@<name>::<event>` form.
 * - `namespace` — `#<name>::<event>` form.
 */
export type ParsedKey =
  | { readonly scope: 'top'; readonly event: string }
  | { readonly scope: 'channel'; readonly name: string; readonly event: string }
  | { readonly scope: 'namespace'; readonly name: string; readonly event: string };

/** Template-literal parser for the key grammar. */
export type ParseKey<TKey extends string> = TKey extends `@${infer Name}::${infer Event}`
  ? { readonly scope: 'channel'; readonly name: Name; readonly event: Event }
  : TKey extends `#${infer Name}::${infer Event}`
    ? { readonly scope: 'namespace'; readonly name: Name; readonly event: Event }
    : { readonly scope: 'top'; readonly event: TKey };

/** Read one slot off a contract/scope, falling back to `{}` when the slot is absent. */
type Slot<TScope, TKey extends string> = TKey extends keyof TScope ? TScope[TKey] : {};

/** Pull `payload` off a `{ payload: P; ... }` entry, otherwise `unknown`. */
type PayloadField<TEntry> = TEntry extends { payload: infer P } ? P : unknown;

/**
 * Find the scope object inside a contract for a parsed key. Returns `never`
 * when the scope doesn't exist (the user used a wrong channel/namespace name).
 */
type ScopeFor<TContract, TParsed extends ParsedKey> = TParsed extends { scope: 'top' }
  ? TContract
  : TParsed extends { scope: 'channel'; name: infer N extends string }
    ? N extends keyof Slot<TContract, 'channels'>
      ? Slot<TContract, 'channels'>[N]
      : never
    : TParsed extends { scope: 'namespace'; name: infer N extends string }
      ? N extends keyof Slot<TContract, 'namespaces'>
        ? Slot<TContract, 'namespaces'>[N]
        : never
      : never;

/**
 * Find the payload type for an event in a scope object. Walks all five inbound
 * slots; the cross-primitive collision guard at build time keeps the lookup
 * unambiguous.
 */
type PayloadOf<TScope, TEvent extends string> = TEvent extends keyof Slot<TScope, 'incoming'>
  ? Slot<TScope, 'incoming'>[TEvent]
  : TEvent extends keyof Slot<TScope, 'requests'>
    ? PayloadField<Slot<TScope, 'requests'>[TEvent]>
    : TEvent extends keyof Slot<TScope, 'streams'>
      ? PayloadField<Slot<TScope, 'streams'>[TEvent]>
      : TEvent extends keyof Slot<TScope, 'resumableStreams'>
        ? PayloadField<Slot<TScope, 'resumableStreams'>[TEvent]>
        : TEvent extends keyof Slot<TScope, 'recordedStreams'>
          ? PayloadField<Slot<TScope, 'recordedStreams'>[TEvent]>
          : never;

/**
 * Find the kind for an event in a scope object. The three stream variants
 * collapse to one `'stream'` kind in the frame.
 */
type KindOf<TScope, TEvent extends string> = TEvent extends keyof Slot<TScope, 'incoming'>
  ? 'incoming'
  : TEvent extends keyof Slot<TScope, 'requests'>
    ? 'request'
    : TEvent extends keyof Slot<TScope, 'streams'>
      ? 'stream'
      : TEvent extends keyof Slot<TScope, 'resumableStreams'>
        ? 'stream'
        : TEvent extends keyof Slot<TScope, 'recordedStreams'>
          ? 'stream'
          : never;

/**
 * The shape of `frame.routing` after a successful narrowing — scope-aware
 * keys are pinned to their literal type, the rest stay optional.
 */
type RoutingFor<TParsed extends ParsedKey> = TParsed extends { scope: 'channel'; name: infer N }
  ? {
      readonly channel: N;
      readonly channelScope?: string | null;
      readonly messageId?: string;
      readonly ackId?: string;
      readonly correlationId?: string;
      readonly streamId?: string;
      readonly seq?: number;
    }
  : TParsed extends { scope: 'namespace'; name: infer N }
    ? {
        readonly namespace: N;
        readonly messageId?: string;
        readonly ackId?: string;
        readonly correlationId?: string;
        readonly streamId?: string;
        readonly seq?: number;
      }
    : {
        readonly messageId?: string;
        readonly ackId?: string;
        readonly correlationId?: string;
        readonly streamId?: string;
        readonly seq?: number;
      };

/**
 * The narrowed `InterceptFrame` shape produced by a successful
 * `matches(contract, key, frame)` or `unsafeCast(contract, key, frame)` call.
 *
 * When the contract is fully known and the key matches a declared event,
 * `payload`, `kind`, and `routing` are all narrowed to the exact shapes
 * pulled from the contract. When the contract is unknown (e.g. inside a
 * helper that takes `Contract<unknown, unknown>`) or the key references
 * a scope/event the contract doesn't declare, the result widens to the
 * base `InterceptFrame` — narrowing fails open, never to `never`. That
 * keeps method variance happy across `Contract<unknown,unknown>` and
 * concrete contracts.
 */
export type FrameFor<TContract, TKey extends string> = unknown extends TContract
  ? InterceptFrame
  : ParseKey<TKey> extends infer TParsed
    ? TParsed extends ParsedKey
      ? ScopeFor<TContract, TParsed> extends infer TScope
        ? [TScope] extends [never]
          ? InterceptFrame
          : TParsed extends { event: infer E extends string }
            ? PayloadOf<TScope, E> extends infer TPayload
              ? KindOf<TScope, E> extends infer TKind
                ? [TPayload] extends [never]
                  ? InterceptFrame
                  : [TKind] extends [never]
                    ? InterceptFrame
                    : InterceptFrame & {
                        readonly event: E;
                        readonly payload: TPayload;
                        readonly kind: TKind;
                        readonly routing: RoutingFor<TParsed>;
                      }
                : never
              : never
            : InterceptFrame
        : InterceptFrame
      : InterceptFrame
    : InterceptFrame;
