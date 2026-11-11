/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './capability.ts';
import { compileRecordedStreamDef } from './compile.ts';
import { recordedStream as recordedStreamDef } from './definition.ts';

describe('recordedStream build-time validation', () => {
  it('builds when declared inside a channel', () => {
    const base = server({
      capabilities: [channels(), recordedStream()],
    });
    const rooms = base.channel('rooms');
    const handle = rooms.recordedStream('tokens', {
      input: v.object({}),
      async *run() {
        yield { token: 'hi' };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  it('builds when the stream is top-level', () => {
    const base = server({
      capabilities: [recordedStream()],
    });
    const handle = base.recordedStream('tokens', {
      input: v.object({}),
      async *run() {
        yield { token: 'hi' };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  // base.recordedStream(...) always carries its generator, so server()/assemble()
  // can't reach the missing-handler path. Call compileRecordedStreamDef directly
  // with an empty handler map, the same path the capability builder feeds.
  it('throws when a recordedStream handler is not assembled', () => {
    const def = recordedStreamDef('tokens', {
      payload: v.object({}),
    });
    expect(() => compileRecordedStreamDef(def, new Map())).toThrow(
      /No handler assembled for recordedStream/,
    );
  });
});
