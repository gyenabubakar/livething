/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WIRE_LIMITS } from '@livething/core';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { compileServerDefinition } from './compile.ts';

// A few guards in compile() only fire on primitives that skipped the builder's
// own early checks (assemble()'s assertUniqueHandlers rejects a top-level
// collision before the engine ever sees it). To exercise the engine guard
// directly we hand-build the server definition the bypass path would produce —
// the same primitives the new builders emit, gathered without assemble().
function serverDef(primitives: readonly Primitive[]): ServerDefinition {
  return {
    __livething: 'server',
    primitives: Object.freeze([...primitives]),
  } as ServerDefinition;
}

describe('boot-time cross-primitive collision guard', () => {
  it('rejects the same event used as both stream and recordedStream at top level', () => {
    const base = server({
      capabilities: [stream(), recordedStream()],
    });
    const asStream = base.stream('feed', { async *run() {} });
    const asRecorded = base.recordedStream('feed', { async *run() {} });
    expect(() => compileServerDefinition(serverDef([asStream, asRecorded]))).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream'/,
    );
  });

  it('rejects the same event used as incoming + recordedStream', () => {
    const base = server({ capabilities: [recordedStream()] });
    const asIncoming = base.on('feed', { run() {} });
    const asRecorded = base.recordedStream('feed', { async *run() {} });
    expect(() => compileServerDefinition(serverDef([asIncoming, asRecorded]))).toThrow(
      /Event name 'feed' is registered as both 'incoming' and 'recordedStream'/,
    );
  });

  it('rejects the collision inside a channel scope', () => {
    const base = server({
      capabilities: [channels(), stream(), recordedStream()],
    });
    const rooms = base.channel('rooms', {});
    const plain = rooms.stream('feed', { async *run() {} });
    const recorded = rooms.recordedStream('feed', { async *run() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [plain, recorded] }))).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream' in channel 'rooms'/,
    );
  });

  it('rejects the collision inside a channel-family scope', () => {
    const base = server({
      capabilities: [channels(), stream(), recordedStream()],
    });
    const rooms = base.channel(['rooms', 'room:{id}'], {});
    const plain = rooms.stream('feed', { async *run() {} });
    const recorded = rooms.recordedStream('feed', { async *run() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [plain, recorded] }))).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream' in channel family 'rooms'/,
    );
  });

  it('allows the same event in different scopes', () => {
    const base = server({
      capabilities: [channels(), stream(), recordedStream()],
    });
    const topFeed = base.stream('feed', { async *run() {} });
    const rooms = base.channel('rooms', {});
    const recorded = rooms.recordedStream('feed', { async *run() {} });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [topFeed, recorded] })),
    ).not.toThrow();
  });
});

describe('static and family channel scope guard', () => {
  it('rejects a family pattern that claims a static channel name', () => {
    const base = server({ capabilities: [channels()] });
    const staticChannel = base.channel('alpha', {});
    const family = base.channel(['rooms', 'alpha'], {});

    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [staticChannel, family] })),
    ).toThrow(/family 'rooms'.*matches the static.*'alpha'/);
  });
});

describe('scope and event name syntax — reserved characters', () => {
  it('rejects a channel name starting with @', () => {
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel('@chat', {})] })),
    ).toThrow(/channel name '@chat' starts with a reserved prefix character/);
  });

  it('rejects a channel name starting with #', () => {
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel('#chat', {})] })),
    ).toThrow(/channel name '#chat' starts with a reserved prefix character/);
  });

  it('rejects a channel name containing ::', () => {
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel('chat::rooms', {})] })),
    ).toThrow(/channel name 'chat::rooms' contains '::'/);
  });

  it('rejects a channel family key starting with @', () => {
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(
        base.assemble({ handlers: [base.channel(['@rooms', 'room:{id}'], {})] }),
      ),
    ).toThrow(/channel name '@rooms' starts with a reserved prefix character/);
  });

  it('rejects a top-level event name containing ::', () => {
    const base = server({});
    expect(() =>
      compileServerDefinition(
        base.assemble({ handlers: [base.on('send::message', { run() {} })] }),
      ),
    ).toThrow(/Event name 'send::message' in top-level contains '::'/);
  });

  it('rejects a top-level event name ending with __', () => {
    const base = server({});
    expect(() => base.on('message__', { run() {} })).toThrow(/reserved '__' suffix/);
  });

  it('rejects request and emit names ending with __', () => {
    const requestBase = server({ capabilities: [clientRequests()] });
    expect(() => requestBase.request('ask__', { run() {} })).toThrow(/reserved '__' suffix/);
    expect(() => serverRequests({ answer__: { out: t<{}>() } })).toThrow(/reserved '__' suffix/);
    expect(() => emits({ update__: t<{}>() })).toThrow(/reserved '__' suffix/);
  });

  it('rejects channel outgoing requests and scheduled task ids ending with __', () => {
    const base = server({ capabilities: [channels(), serverRequests()] });
    expect(() =>
      base.channel('room', { capabilities: [serverRequests({ answer__: { out: t<{}>() } })] }),
    ).toThrow(/reserved '__' suffix/);
    expect(() => scheduled({ cleanup__: null })).toThrow(/reserved '__' suffix/);
  });

  it('rejects a declared event name longer than the wire limit', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);
    const base = server({});
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.on(tooLong, { run() {} })] })),
    ).toThrow(/the wire protocol limit\s+is 128/);
  });

  it('rejects a declared channel name longer than the wire limit', () => {
    const tooLong = 'c'.repeat(WIRE_LIMITS.channel + 1);
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel(tooLong, {})] })),
    ).toThrow(/channel name is \d+ characters; the wire protocol limit is 256/);
  });

  it('rejects an event name containing :: inside a channel', () => {
    const base = server({ capabilities: [channels()] });
    const chat = base.channel('chat', {});
    const send = chat.on('send::message', { run() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [send] }))).toThrow(
      /Event name 'send::message' in channel 'chat' contains '::'/,
    );
  });

  it('rejects a stream event name containing ::', () => {
    const base = server({ capabilities: [stream()] });
    expect(() =>
      compileServerDefinition(
        base.assemble({ handlers: [base.stream('count::up', { async *run() {} })] }),
      ),
    ).toThrow(/Event name 'count::up' in top-level contains '::'/);
  });

  it('allows ordinary names with @, #, and : at non-start positions', () => {
    const base = server({ capabilities: [channels()] });
    const chat = base.channel('chat@v1', {});
    const handle = base.on('user:created', { run() {} });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [chat, handle] })),
    ).not.toThrow();
  });

  it('allows a dynamic family key at the channelFamily wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelFamily);
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel([key, 'room:{id}'], {})] })),
    ).not.toThrow();
  });

  it('rejects a dynamic family key one over the channelFamily wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelFamily + 1);
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel([key, 'room:{id}'], {})] })),
    ).toThrow(/channel name is \d+ characters; the wire protocol limit is 128/);
  });

  it('allows a static channel name up to the larger channel wire limit', () => {
    const name = 'c'.repeat(WIRE_LIMITS.channel);
    const base = server({ capabilities: [channels()] });
    expect(() =>
      compileServerDefinition(base.assemble({ handlers: [base.channel(name, {})] })),
    ).not.toThrow();
  });

  it('rejects an ephemeral stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const base = server({ capabilities: [stream()] });
    const handle = base.stream('feed', {
      nudges: { [tooLong]: v.object({}) },
      async *run() {},
    });
    expect(() => compileServerDefinition(base.assemble({ handlers: [handle] }))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });

  it('rejects a recorded stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const base = server({ capabilities: [recordedStream()] });
    const handle = base.recordedStream('feed', {
      maxChunks: 10,
      nudges: { [tooLong]: v.object({}) },
      async *run() {},
    });
    expect(() => compileServerDefinition(base.assemble({ handlers: [handle] }))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });
});

describe('boot-time same-kind duplicate guard', () => {
  // Duplicate declarations prevent compilation, so the server cannot start
  // with ambiguous event or channel definitions.

  it('rejects two incoming declarations with the same event name at top level', () => {
    const base = server({});
    const first = base.on('same', { run() {} });
    const second = base.on('same', { run() {} });
    expect(() => compileServerDefinition(serverDef([first, second]))).toThrow(
      /Duplicate incoming declaration for "same"/,
    );
  });

  it('rejects two channel declarations with the same name', () => {
    const base = server({ capabilities: [channels()] });
    const roomA = base.channel('room', {});
    roomA.on('msg', { run() {} });
    const roomB = base.channel('room', {});
    roomB.on('msg2', { run() {} });

    expect(() => compileServerDefinition(base.assemble({ handlers: [roomA, roomB] }))).toThrow(
      /Duplicate channel declaration for "room"/,
    );
  });

  it('rejects two incoming declarations with the same event name inside a channel scope', () => {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {});
    const first = room.on('msg', { run() {} });
    const second = room.on('msg', { run() {} });
    expect(() => compileServerDefinition(base.assemble({ handlers: [first, second] }))).toThrow(
      /Duplicate incoming in channel "room" declaration for "msg"/,
    );
  });
});
