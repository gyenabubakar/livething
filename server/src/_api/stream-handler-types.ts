/* oxlint-disable @typescript-eslint/no-explicit-any */

type NudgeMessagesFromMap<TNudges> =
  TNudges extends Record<string, unknown>
    ? readonly {
        [K in keyof TNudges & string]: {
          event: K;
          payload: TNudges[K];
        };
      }[keyof TNudges & string][]
    : readonly never[];

type MaybeNudgesApi<TEntry> = TEntry extends { nudges: infer TNudges }
  ? keyof TNudges extends never
    ? {}
    : { nudges(value: unknown): NudgeMessagesFromMap<TNudges> }
  : {};

type ChunkOf<TEntry> = TEntry extends { chunk: infer TChunk } ? TChunk : unknown;

type CursorOf<TEntry> = TEntry extends { cursor: infer TCursor } ? TCursor : unknown;

export type PlainStreamHandlerContext<TBaseCtx, TEntry> = TBaseCtx & MaybeNudgesApi<TEntry>;

export type PlainStreamGenerator<TBaseCtx, TEntry> = (
  ctx: PlainStreamHandlerContext<TBaseCtx, TEntry>,
  payload: TEntry extends { payload: infer TPayload } ? TPayload : never,
) => AsyncGenerator<ChunkOf<TEntry>, void, unknown>;

export type ResumableStreamHandlerContext<TBaseCtx, TEntry> = TBaseCtx &
  MaybeNudgesApi<TEntry> & {
    stream: {
      cursor: CursorOf<TEntry> | null;
      attempt: number;
      withCursor(chunk: ChunkOf<TEntry>, cursor: CursorOf<TEntry>): ChunkOf<TEntry>;
    };
  };

export type ResumableStreamGenerator<TBaseCtx, TEntry> = (
  ctx: ResumableStreamHandlerContext<TBaseCtx, TEntry>,
  payload: TEntry extends { payload: infer TPayload } ? TPayload : never,
) => AsyncGenerator<ChunkOf<TEntry>, void, unknown>;

export type RecordedStreamHandlerContext<TBaseCtx, TEntry> = TBaseCtx & MaybeNudgesApi<TEntry>;

export type RecordedStreamGenerator<TBaseCtx, TEntry> = (
  ctx: RecordedStreamHandlerContext<TBaseCtx, TEntry>,
  payload: TEntry extends { payload: infer TPayload } ? TPayload : never,
) => AsyncGenerator<ChunkOf<TEntry>, void, unknown>;
