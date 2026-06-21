/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WIRE_LIMITS } from '@wskit/core';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { persistence } from '~/persistence/capability.ts';
import { requests } from '~/request/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { compileHandlerDefinition } from './compile.ts';

interface Env {
  SECRET: string;
}

// A few guards in compile() only fire on primitives that skipped the builder's
// own early checks (assemble()'s assertUniqueHandlers rejects a top-level
// collision before the engine ever sees it). To exercise the engine guard
// directly we hand-build the server definition the bypass path would produce —
// the same primitives the new builders emit, gathered without assemble().
function serverDef(
  primitives: readonly Primitive[],
  features: readonly string[] = [],
): ServerDefinition {
  return {
    __wskit: 'server',
    primitives: Object.freeze([...primitives]),
    __features: Object.freeze(new Set(features)),
  } as ServerDefinition;
}

describe('boot-time cross-primitive collision guard', () => {
  it('rejects the same event used as both stream and resumableStream at top level', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [persistence(), stream(), resumableStream()],
    });
    const asStream = base.stream('feed', { async *run() {} });
    const asResumable = base.resumableStream('feed', { async *run() {} });
    expect(() =>
      compileHandlerDefinition(serverDef([asStream, asResumable], ['persistence'])),
    ).toThrow(/Event name 'feed' is registered as both 'stream' and 'resumableStream'/);
  });

  it('rejects the same event used as both resumableStream and recordedStream', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [persistence(), resumableStream(), recordedStream()],
    });
    const asResumable = base.resumableStream('feed', { async *run() {} });
    const asRecorded = base.recordedStream('feed', { async *run() {} });
    expect(() =>
      compileHandlerDefinition(serverDef([asResumable, asRecorded], ['persistence'])),
    ).toThrow(/Event name 'feed' is registered as both 'resumableStream' and 'recordedStream'/);
  });

  it('rejects the same event used as incoming + recordedStream', () => {
    const base = define({ env: t<Env>(), capabilities: [persistence(), recordedStream()] });
    const asIncoming = base.on('feed', { run() {} });
    const asRecorded = base.recordedStream('feed', { async *run() {} });
    expect(() =>
      compileHandlerDefinition(serverDef([asIncoming, asRecorded], ['persistence'])),
    ).toThrow(/Event name 'feed' is registered as both 'incoming' and 'recordedStream'/);
  });

  it('rejects the collision inside a channel scope', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [persistence(), channels(), stream(), recordedStream()],
    });
    const rooms = base.channel('rooms', {});
    rooms.stream('feed', { async *run() {} });
    rooms.recordedStream('feed', { async *run() {} });
    expect(() => compileHandlerDefinition(base.assemble(rooms))).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'recordedStream' in channel 'rooms'/,
    );
  });

  it('rejects the collision inside a channel-family scope', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [persistence(), channels(), stream(), resumableStream()],
    });
    const rooms = base.channel(['rooms', 'room:{id}'], {});
    rooms.stream('feed', { async *run() {} });
    rooms.resumableStream('feed', { async *run() {} });
    expect(() => compileHandlerDefinition(base.assemble(rooms))).toThrow(
      /Event name 'feed' is registered as both 'stream' and 'resumableStream' in channel family 'rooms'/,
    );
  });

  it('allows the same event in different scopes', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [persistence(), channels(), stream(), recordedStream()],
    });
    const topFeed = base.stream('feed', { async *run() {} });
    const rooms = base.channel('rooms', {});
    rooms.recordedStream('feed', { async *run() {} });
    expect(() => compileHandlerDefinition(base.assemble(topFeed, rooms))).not.toThrow();
  });
});

describe('scope and event name syntax — reserved characters', () => {
  it('rejects a channel name starting with @', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() => compileHandlerDefinition(base.assemble(base.channel('@chat', {})))).toThrow(
      /channel name '@chat' starts with a reserved prefix character/,
    );
  });

  it('rejects a channel name starting with #', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() => compileHandlerDefinition(base.assemble(base.channel('#chat', {})))).toThrow(
      /channel name '#chat' starts with a reserved prefix character/,
    );
  });

  it('rejects a channel name containing ::', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() => compileHandlerDefinition(base.assemble(base.channel('chat::rooms', {})))).toThrow(
      /channel name 'chat::rooms' contains '::'/,
    );
  });

  it('rejects a channel family key starting with @', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() =>
      compileHandlerDefinition(base.assemble(base.channel(['@rooms', 'room:{id}'], {}))),
    ).toThrow(/channel name '@rooms' starts with a reserved prefix character/);
  });

  it('rejects a top-level event name containing ::', () => {
    const base = define({ env: t<Env>() });
    expect(() =>
      compileHandlerDefinition(base.assemble(base.on('send::message', { run() {} }))),
    ).toThrow(/Event name 'send::message' in top-level contains '::'/);
  });

  it('rejects a top-level event name ending with __', () => {
    const base = define({ env: t<Env>() });
    expect(() => base.on('message__', { run() {} })).toThrow(/reserved '__' suffix/);
  });

  it('rejects request and emit names ending with __', () => {
    const requestBase = define({ env: t<Env>(), capabilities: [requests()] });
    expect(() => requestBase.request('ask__', { run() {} })).toThrow(/reserved '__' suffix/);
    expect(() => requests({ answer__: t<{}>() })).toThrow(/reserved '__' suffix/);
    expect(() => emits({ update__: t<{}>() })).toThrow(/reserved '__' suffix/);
  });

  it('rejects channel outgoing requests and scheduled task ids ending with __', () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), requests()] });
    expect(() => base.channel('room', { outgoing: { requests: { answer__: t<{}>() } } })).toThrow(
      /reserved '__' suffix/,
    );
    expect(() => scheduled({ cleanup__: null })).toThrow(/reserved '__' suffix/);
  });

  it('rejects a declared event name longer than the wire limit', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);
    const base = define({ env: t<Env>() });
    expect(() => compileHandlerDefinition(base.assemble(base.on(tooLong, { run() {} })))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });

  it('rejects a declared channel name longer than the wire limit', () => {
    const tooLong = 'c'.repeat(WIRE_LIMITS.channel + 1);
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() => compileHandlerDefinition(base.assemble(base.channel(tooLong, {})))).toThrow(
      /channel name is \d+ characters; the wire protocol limit is 256/,
    );
  });

  it('rejects an event name containing :: inside a channel', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const chat = base.channel('chat', {});
    chat.on('send::message', { run() {} });
    expect(() => compileHandlerDefinition(base.assemble(chat))).toThrow(
      /Event name 'send::message' in channel 'chat' contains '::'/,
    );
  });

  it('rejects a stream event name containing ::', () => {
    const base = define({ env: t<Env>(), capabilities: [stream()] });
    expect(() =>
      compileHandlerDefinition(base.assemble(base.stream('count::up', { async *run() {} }))),
    ).toThrow(/Event name 'count::up' in top-level contains '::'/);
  });

  it('allows ordinary names with @, #, and : at non-start positions', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const chat = base.channel('chat@v1', {});
    const handle = base.on('user:created', { run() {} });
    expect(() => compileHandlerDefinition(base.assemble(chat, handle))).not.toThrow();
  });

  it('allows a dynamic family key at the channelFamily wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelFamily);
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() =>
      compileHandlerDefinition(base.assemble(base.channel([key, 'room:{id}'], {}))),
    ).not.toThrow();
  });

  it('rejects a dynamic family key one over the channelFamily wire limit', () => {
    const key = 'k'.repeat(WIRE_LIMITS.channelFamily + 1);
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() =>
      compileHandlerDefinition(base.assemble(base.channel([key, 'room:{id}'], {}))),
    ).toThrow(/channel name is \d+ characters; the wire protocol limit is 128/);
  });

  it('allows a static channel name up to the larger channel wire limit', () => {
    const name = 'c'.repeat(WIRE_LIMITS.channel);
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    expect(() => compileHandlerDefinition(base.assemble(base.channel(name, {})))).not.toThrow();
  });

  it('rejects an ephemeral stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const base = define({ env: t<Env>(), capabilities: [stream()] });
    const handle = base.stream('feed', {
      nudges: { [tooLong]: v.object({}) },
      async *run() {},
    });
    expect(() => compileHandlerDefinition(base.assemble(handle))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });

  it('rejects a resumable stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const base = define({ env: t<Env>(), capabilities: [persistence(), resumableStream()] });
    const handle = base.resumableStream('feed', {
      nudges: { [tooLong]: v.object({}) },
      async *run() {},
    });
    expect(() => compileHandlerDefinition(base.assemble(handle))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });

  it('rejects a recorded stream nudge name over the wire limit', () => {
    const tooLong = 'n'.repeat(WIRE_LIMITS.event + 1);
    const base = define({ env: t<Env>(), capabilities: [persistence(), recordedStream()] });
    const handle = base.recordedStream('feed', {
      maxChunks: 10,
      nudges: { [tooLong]: v.object({}) },
      async *run() {},
    });
    expect(() => compileHandlerDefinition(base.assemble(handle))).toThrow(
      /the wire protocol limit\s+is 128/,
    );
  });
});

describe('boot-time same-kind duplicate guard', () => {
  // Pre-fix every `.set()` in compile silently overwrote on duplicate keys.
  // A refactor that pasted an incoming("same", ...) twice, or two channel
  // definitions with the same name, just kept the last one with no error.
  // Each test below configures a duplicate and asserts compile refuses to
  // produce a CompiledServer — the engine never gets a chance to construct,
  // so the server refuses to start.

  it('rejects two incoming declarations with the same event name at top level', () => {
    const base = define({ env: t<Env>() });
    const first = base.on('same', { run() {} });
    const second = base.on('same', { run() {} });
    expect(() => compileHandlerDefinition(serverDef([first, second]))).toThrow(
      /Duplicate incoming declaration for "same"/,
    );
  });

  it('rejects two channel declarations with the same name', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const roomA = base.channel('room', {});
    roomA.on('msg', { run() {} });
    const roomB = base.channel('room', {});
    roomB.on('msg2', { run() {} });
    expect(() => compileHandlerDefinition(base.assemble(roomA, roomB))).toThrow(
      /Duplicate channel declaration for "room"/,
    );
  });

  it('rejects two incoming declarations with the same event name inside a channel scope', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    const room = base.channel('room', {});
    room.on('msg', { run() {} });
    room.on('msg', { run() {} });
    expect(() => compileHandlerDefinition(base.assemble(room))).toThrow(
      /Duplicate incoming in channel "room" declaration for "msg"/,
    );
  });
});
