/* oxlint-disable @typescript-eslint/no-explicit-any */
import { contract } from '~/_api/contract.ts';
import { implement } from '~/_api/implement.ts';
import { channel } from '~/channel/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './definition.ts';

describe('recordedStream build-time validation', () => {
  it('throws when recordedStream is declared without persistence: true', () => {
    const c = contract<Record<string, unknown>>('app')({
      definitions: [
        recordedStream('tokens', {
          payload: v.object({}),
          chunk: v.object({ token: v.string() }),
        }),
      ],
    });
    expect(() =>
      implement(c)
        .recordedStream('tokens', async function* () {
          yield { token: 'hi' };
        })
        .build(),
    ).toThrow(/persistence: true/);
  });

  it('throws when declared inside a channel (top-level only in v1)', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        channel('rooms', {
          definitions: [
            recordedStream('tokens', {
              payload: v.object({}),
              chunk: v.object({ token: v.string() }),
            }),
          ],
        }),
      ],
    });
    expect(() => implement(c).build()).toThrow(/top-level only/);
  });

  it('builds when persistence is enabled and the stream is top-level', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        recordedStream('tokens', {
          payload: v.object({}),
          chunk: v.object({ token: v.string() }),
        }),
      ],
    });
    expect(() =>
      implement(c)
        .recordedStream('tokens', async function* () {
          yield { token: 'hi' };
        })
        .build(),
    ).not.toThrow();
  });

  it('throws at build when a recordedStream declaration has no handler', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        recordedStream('tokens', {
          payload: v.object({}),
          chunk: v.object({ token: v.string() }),
        }),
      ],
    });
    expect(() => implement(c).build()).toThrow(/No generator registered for recordedStream/);
  });
});
