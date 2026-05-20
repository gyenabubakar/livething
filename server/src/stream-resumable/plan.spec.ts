/* oxlint-disable @typescript-eslint/no-explicit-any */
import { contract } from '~/_api/contract.ts';
import { implement } from '~/_api/implement.ts';
import { channel } from '~/channel/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { resumableStream } from './definition.ts';

describe('resumableStream build-time validation', () => {
  it('throws when resumableStream is declared without persistence: true', () => {
    const c = contract<Record<string, unknown>>('app')({
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({ idx: v.number() }),
        }),
      ],
    });
    expect(() =>
      implement(c)
        .resumableStream('feed', async function* () {
          yield { idx: 1 };
        })
        .build(),
    ).toThrow(/persistence: true/);
  });

  it('builds when persistence is enabled and the stream is top-level', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({ idx: v.number() }),
        }),
      ],
    });
    expect(() =>
      implement(c)
        .resumableStream('feed', async function* () {
          yield { idx: 1 };
        })
        .build(),
    ).not.toThrow();
  });

  it('builds when declared inside a channel', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        channel('rooms', {
          definitions: [
            resumableStream('feed', {
              payload: v.object({}),
              chunk: v.object({ idx: v.number() }),
            }),
          ],
        }),
      ],
    });
    expect(() =>
      implement(c)
        .channel('rooms', (ch) =>
          ch.resumableStream('feed', async function* () {
            yield { idx: 1 };
          }),
        )
        .build(),
    ).not.toThrow();
  });

  it('builds when declared inside a namespace', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        namespace('v1', {
          definitions: [
            resumableStream('feed', {
              payload: v.object({}),
              chunk: v.object({ idx: v.number() }),
            }),
          ],
        }),
      ],
    });
    expect(() =>
      implement(c)
        .namespace('v1', (ns) =>
          ns.resumableStream('feed', async function* () {
            yield { idx: 1 };
          }),
        )
        .build(),
    ).not.toThrow();
  });

  it('throws at build when a resumableStream declaration has no handler', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({ idx: v.number() }),
        }),
      ],
    });
    expect(() => implement(c).build()).toThrow(/No generator registered for resumableStream/);
  });

  it('throws at build when keep-running is used on a non-broadcast resumableStream', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({ idx: v.number() }),
          onDisconnect: 'keep-running',
        }),
      ],
    });
    expect(() =>
      implement(c)
        .resumableStream('feed', async function* () {
          yield { idx: 1 };
        })
        .build(),
    ).toThrow(/keep-running.*broadcast/);
  });

  it('allows keep-running on a broadcast resumableStream', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        resumableStream('feed', {
          payload: v.object({}),
          chunk: v.object({ idx: v.number() }),
          broadcast: true,
          onDisconnect: 'keep-running',
        }),
      ],
    });
    expect(() =>
      implement(c)
        .resumableStream('feed', async function* () {
          yield { idx: 1 };
        })
        .build(),
    ).not.toThrow();
  });
});
