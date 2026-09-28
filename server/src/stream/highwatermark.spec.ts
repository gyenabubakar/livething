/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildActiveStream } from '~/_engine/stream-common/active-stream.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import { describe, expect, it } from 'vitest';

describe('highWaterMark validation (Major 7)', () => {
  it('rejects a zero or negative highWaterMark at stream definition time', () => {
    expect(() => stream('feed', { highWaterMark: 0 })).toThrow(/highWaterMark must be a positive/);
    expect(() => stream('feed', { highWaterMark: -1 })).toThrow(/highWaterMark must be a positive/);
    expect(() => stream('feed', { highWaterMark: Number.NaN })).toThrow(
      /highWaterMark must be a positive/,
    );
  });

  it('rejects it on resumable and recorded streams too', () => {
    expect(() => resumableStream('paginate', { highWaterMark: 0 })).toThrow(
      /highWaterMark must be a positive/,
    );
    expect(() => recordedStream('history', { highWaterMark: -5 })).toThrow(
      /highWaterMark must be a positive/,
    );
  });

  it('accepts a positive highWaterMark or its absence', () => {
    expect(() => stream('feed', { highWaterMark: 64 * 1024 })).not.toThrow();
    expect(() => stream('feed', {})).not.toThrow();
    expect(() => stream('feed')).not.toThrow();
  });

  it('is also enforced as a runtime backstop in buildActiveStream', () => {
    const connection = { id: 'c1', descriptor: { bufferedAmount: () => 0 } } as any;
    const input = {
      streamId: 's1',
      event: 'feed',
      connection,
      generator: (async function* () {})(),
      nudges: [],
      highWaterMark: 0,
    };

    expect(() => buildActiveStream(input as any)).toThrow(/highWaterMark must be a positive/);
    expect(() => buildActiveStream({ ...input, highWaterMark: 1024 } as any)).not.toThrow();
  });
});
