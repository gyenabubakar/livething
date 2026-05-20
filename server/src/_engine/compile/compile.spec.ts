/* oxlint-disable @typescript-eslint/no-explicit-any */
import { contract } from '~/_api/contract.ts';
import { implement } from '~/_api/implement.ts';
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import { recordedStream } from '~/stream-recorded/definition.ts';
import { resumableStream } from '~/stream-resumable/definition.ts';
import { stream } from '~/stream/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { compileHandlerDefinition } from './compile.ts';

describe('boot-time cross-primitive collision guard', () => {
  it('rejects the same event used as both stream and resumableStream at top level', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        stream('feed', { payload: v.object({}), chunk: v.object({}) }),
        resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('feed', async function* () {
            yield {};
          })
          .resumableStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'stream' and 'resumableStream'/);
  });

  it('rejects the same event used as both resumableStream and recordedStream', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
        recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .resumableStream('feed', async function* () {
            yield {};
          })
          .recordedStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'resumableStream' and 'recordedStream'/);
  });

  it('rejects the same event used as incoming + recordedStream', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        incoming('feed', v.object({})),
        recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .on('feed', () => {})
          .recordedStream('feed', async function* () {
            yield {};
          })
          .build(),
      ),
    ).toThrow(/Event name 'feed' is registered as both 'incoming' and 'recordedStream'/);
  });

  it('rejects the collision inside a channel scope', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        channel('rooms', {
          definitions: [
            stream('feed', { payload: v.object({}), chunk: v.object({}) }),
            recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
          ],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('rooms', (ch) =>
            ch
              .stream('feed', async function* () {
                yield {};
              })
              .recordedStream('feed', async function* () {
                yield {};
              }),
          )
          .build(),
      ),
    ).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream' in channel 'rooms'/,
    );
  });

  it('rejects the collision inside a namespace scope', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        namespace('v1', {
          definitions: [
            resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
            recordedStream('feed', { payload: v.object({}), chunk: v.object({}) }),
          ],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .namespace('v1', (ns) =>
            ns
              .resumableStream('feed', async function* () {
                yield {};
              })
              .recordedStream('feed', async function* () {
                yield {};
              }),
          )
          .build(),
      ),
    ).toThrow(
      /Event name 'feed' is registered as both 'resumableStream' and 'recordedStream' in namespace 'v1'/,
    );
  });

  it('rejects the collision inside a channel-family scope', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        channel(scope('rooms', /^room:.+$/), {
          definitions: [
            stream('feed', { payload: v.object({}), chunk: v.object({}) }),
            resumableStream('feed', { payload: v.object({}), chunk: v.object({}) }),
          ],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .channel('rooms', (ch) =>
            ch
              .stream('feed', async function* () {
                yield {};
              })
              .resumableStream('feed', async function* () {
                yield {};
              }),
          )
          .build(),
      ),
    ).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'resumableStream' in channel family 'rooms'/,
    );
  });

  it('allows the same event in different scopes', () => {
    const c = contract<Record<string, unknown>>('app')({
      persistence: true,
      definitions: [
        stream('feed', { payload: v.object({}), chunk: v.object({}) }),
        channel('rooms', {
          definitions: [recordedStream('feed', { payload: v.object({}), chunk: v.object({}) })],
        }),
      ],
    });
    expect(() =>
      compileHandlerDefinition(
        implement(c)
          .stream('feed', async function* () {
            yield {};
          })
          .channel('rooms', (ch) =>
            ch.recordedStream('feed', async function* () {
              yield {};
            }),
          )
          .build(),
      ),
    ).not.toThrow();
  });
});

describe('namespace cannot contain a channel or another namespace', () => {
  it('build throws when a channel is declared inside a namespace via `as any`', () => {
    const sneakyContract = contract<Record<string, unknown>>('app')({
      definitions: [
        namespace('admin', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          definitions: [channel('audit', { definitions: [] }) as any],
        }),
      ],
    });
    expect(() => compileHandlerDefinition(implement(sneakyContract).build())).toThrow(
      /namespace 'admin' contains channel 'audit'/,
    );
  });

  it('build throws when a namespace is nested inside another namespace via `as any`', () => {
    const sneakyContract = contract<Record<string, unknown>>('app')({
      definitions: [
        namespace('outer', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          definitions: [namespace('inner', { definitions: [] }) as any],
        }),
      ],
    });
    expect(() => compileHandlerDefinition(implement(sneakyContract).build())).toThrow(
      /namespace 'outer' contains namespace 'inner'/,
    );
  });
});
