/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ServerDefinition } from '~/define-server.ts';
import type { ErrorDef, ValidationFailed } from '~/errors.ts';
import type { ErrorsPrimitive } from '~/primitives/errors.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type AnyErrorDef = ErrorDef<string, any>;

type SimplifyDeep<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly unknown[]
    ? { [TIndex in keyof T]: SimplifyDeep<T[TIndex]> }
    : T extends object
      ? { [TKey in keyof T]: SimplifyDeep<T[TKey]> } & {}
      : T;

type PrimitivesOf<TServer> =
  TServer extends ServerDefinition<infer TPrimitives> ? TPrimitives : never;

type OutgoingToIncoming<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<
    TPrimitives[number],
    AnyOutgoing
  > as TPrimitive['event']]: TPrimitive extends OutgoingPrimitive<string, infer TPayload>
    ? TPayload
    : never;
};

type IncomingToOutgoing<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<
    TPrimitives[number],
    AnyIncoming
  > as TPrimitive['event']]: TPrimitive extends IncomingPrimitive<string, infer TPayload, any>
    ? TPayload
    : never;
};

type RequestsMap<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<
    TPrimitives[number],
    AnyRequest
  > as TPrimitive['event']]: TPrimitive extends RequestPrimitive<
    string,
    infer TPayload,
    infer TResponse,
    any
  >
    ? {
        payload: TPayload;
        response: TResponse;
      }
    : never;
};

type NudgeMap<TNudges extends readonly NudgeDeclaration[]> = {
  [TNudge in TNudges[number] as TNudge['event']]: TNudge extends NudgeDeclaration<
    string,
    infer TPayload
  >
    ? TPayload
    : never;
};

type StreamEntry<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, infer TChunks, infer TNudges>
    ? {
        payload: TPayload;
        chunks: TChunks;
      } & (keyof NudgeMap<TNudges> extends never ? {} : { nudges: NudgeMap<TNudges> })
    : never;

type StreamsMap<TPrimitives extends readonly unknown[]> = {
  [TPrimitive in Extract<
    TPrimitives[number],
    AnyGenerate
  > as TPrimitive['event']]: TPrimitive extends GeneratePrimitive<infer TStream, any, any>
    ? StreamEntry<TStream>
    : never;
};

type DeclaredErrorUnion<TPrimitives extends readonly unknown[]> =
  Extract<TPrimitives[number], ErrorsPrimitive<readonly AnyErrorDef[]>> extends ErrorsPrimitive<
    infer TDefs
  >
    ? TDefs[number]
    : never;

type ErrorMap<TDefs> = {
  [TDef in TDefs as TDef extends ErrorDef<infer TCode, any> ? TCode : never]: TDef extends ErrorDef<
    string,
    infer TDetail
  >
    ? TDetail
    : never;
};

type BuiltInErrorUnion = typeof ValidationFailed;

/**
 * Read a wskit server definition and produce the client contract type.
 *
 * This first pass covers the top-level contract:
 * `incoming`, `outgoing`, `requests`, `streams`, and `__errors__`.
 * Namespace and channel inference will layer on top of this later.
 */
export type InferClient<TServer extends ServerDefinition> = SimplifyDeep<{
  incoming: OutgoingToIncoming<PrimitivesOf<TServer>>;
  outgoing: IncomingToOutgoing<PrimitivesOf<TServer>>;
  namespaces: {};
  channels: {};
  streams: StreamsMap<PrimitivesOf<TServer>>;
  requests: RequestsMap<PrimitivesOf<TServer>>;
  __errors__: ErrorMap<DeclaredErrorUnion<PrimitivesOf<TServer>> | BuiltInErrorUnion>;
}>;
