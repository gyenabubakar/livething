/* oxlint-disable no-unused-vars */
/**
 * Compile-time checks for `binary()`: the declarations, the `binary.on` handlers, the
 * `.binary` senders and their info types, and the binary keys `InferClient` carries.
 */
import { t } from '~/_api/definitions.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import type { InferPluginClient } from '~/_define/plugins.ts';
import type { InferClient } from '~/infer-client.ts';

const base = server({
  capabilities: [
    binary({ emits: { 'avatar-preview': t<null>(), 'avatar-cropped': t<{ width: number }>() } }),
    emits({ 'avatar-saved': t<{ userId: string }>() }),
    channels(),
    tags((ephemeral) => [ephemeral('team', t<string>())]),
  ],
});

const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [
    binary({ emits: { 'screen-frame': t<{ from: string }>() } }),
    emits({ 'screen-share-started': t<{ from: string }>() }),
  ],
});

const handleUploadAvatar = base.binary.on('upload-avatar', {
  input: v.object({ fileType: v.picklist(['image/png', 'image/jpeg']) }),
  maxBytes: 2 * 1024 * 1024,
  run(ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<{ fileType: 'image/png' | 'image/jpeg' }>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();

    expectTypeOf(ctx.binary.send('avatar-preview', bytes, { info: null })).toEqualTypeOf<boolean>();
    ctx.binary.send('avatar-cropped', bytes.buffer as ArrayBuffer, { info: { width: 64 } });
    ctx.binary.send('avatar-preview', undefined, { info: null });
    // @ts-expect-error: the info of 'avatar-preview' is null
    ctx.binary.send('avatar-preview', bytes, { info: { width: 64 } });
    // @ts-expect-error: 'avatar-saved' is a JSON event, not a binary one
    ctx.binary.send('avatar-saved', bytes, { info: { userId: 'u_amara' } });
    // @ts-expect-error: 'avatar-preview' is a binary event, not a JSON one
    ctx.send('avatar-preview', null);
    // @ts-expect-error: the bytes must be a Uint8Array or an ArrayBuffer
    ctx.binary.send('avatar-preview', 'bytes', { info: null });
    // @ts-expect-error: no replay capability is listed, so there is no binary.sendReplay
    ctx.binary.sendReplay;

    expectTypeOf(
      ctx.binary.broadcast('avatar-preview', bytes, { info: null, includeSelf: true }),
    ).toEqualTypeOf<void>();
    expectTypeOf(
      ctx.user.binary.broadcast('avatar-preview', bytes, { info: null }),
    ).toEqualTypeOf<number>();
    expectTypeOf(
      ctx.connections.get(ctx.connection).binary.send('avatar-preview', bytes, { info: null }),
    ).toEqualTypeOf<boolean>();
    ctx.users.get('u_kofi').binary.broadcast('avatar-preview', bytes, { info: null });
    ctx.tags.ephemeral('team').binary.broadcast('avatar-preview', bytes, { info: null });

    const designTeam = ctx.tags.ephemeral('team').ref('design');
    designTeam.binary.broadcast('avatar-preview', bytes, { info: null });
    // @ts-expect-error: 'avatar-preveiw' is not a binary event
    ctx.tags.ephemeral('team').binary.broadcast('avatar-preveiw', bytes, { info: null });
    // @ts-expect-error: the info of 'avatar-cropped' is { width: number }
    ctx.tags.ephemeral('team').binary.broadcast('avatar-cropped', bytes, { info: null });
    // @ts-expect-error: 'avatar-preveiw' is not a binary event
    designTeam.binary.broadcast('avatar-preveiw', bytes, { info: null });
    // @ts-expect-error: the info of 'avatar-preview' is null
    designTeam.binary.broadcast('avatar-preview', undefined, { info: { width: 64 } });

    const design = ctx.channels.get(rooms.at({ roomId: 'design' }));
    design.binary.broadcast('screen-frame', bytes, { info: { from: ctx.user.id } });
    // @ts-expect-error: 'screen-frame' needs its info
    design.binary.broadcast('screen-frame', bytes, { info: null });
    // @ts-expect-error: the channel's binary events are not JSON events
    design.broadcast('screen-frame', { from: ctx.user.id });
    design.broadcast('screen-share-started', { from: ctx.user.id });
  },
});

const handleShareScreenFrame = rooms.binary.on('share-screen-frame', {
  input: v.null(),
  run(ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<null>();
    ctx.channel.binary.broadcast('screen-frame', bytes, { info: { from: ctx.user.id } });
    expectTypeOf(
      ctx.channel.binary.broadcastTo('screen-frame', bytes, {
        to: ctx.connection,
        info: { from: 'u_amara' },
      }),
    ).toEqualTypeOf<number>();
    expectTypeOf(
      ctx.channel.binary.send('screen-frame', bytes, { info: { from: 'u_amara' } }),
    ).toEqualTypeOf<number>();
    // @ts-expect-error: 'avatar-preview' belongs to the root, not to the channel
    ctx.channel.binary.broadcast('avatar-preview', bytes, { info: null });
  },
});

const handleRenameRoom = rooms.on('rename-room', {
  run(ctx) {
    ctx.channel.binary.broadcast('screen-frame', undefined, { info: { from: ctx.user.id } });
  },
});

// A binary handler with no input gets `unknown` info.
const handleSendSticker = base.binary.on('send-sticker', {
  run(_ctx, input, bytes) {
    expectTypeOf(input).toEqualTypeOf<unknown>();
    expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
  },
});

export const huddle = base.assemble({
  handlers: [handleUploadAvatar, handleShareScreenFrame, handleRenameRoom, handleSendSticker],
  api: (ctx) => {
    ctx.binary.broadcast('avatar-preview', new Uint8Array(4), { info: null });
    ctx.channels
      .get(rooms.at({ roomId: 'design' }))
      .binary.broadcast('screen-frame', undefined, { info: { from: 'admin' } });
    ctx.channels.binary.broadcast('screen-frame', undefined, {
      channel: { family: 'rooms', name: 'room:design' },
      info: { from: 'admin' },
    });
    return {};
  },
});

type HuddleClient = InferClient<typeof huddle>;

expectTypeOf<HuddleClient['binary']>().toEqualTypeOf<{
  incoming: { 'avatar-preview': null; 'avatar-cropped': { width: number } };
  outgoing: {
    'upload-avatar': { fileType: 'image/png' | 'image/jpeg' };
    'send-sticker': unknown;
  };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();
expectTypeOf<HuddleClient['channels']['rooms']['binary']>().toEqualTypeOf<{
  incoming: { 'screen-frame': { from: string } };
  outgoing: { 'share-screen-frame': null };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();
expectTypeOf<HuddleClient['incoming']>().toEqualTypeOf<{ 'avatar-saved': { userId: string } }>();
expectTypeOf<HuddleClient['channels']['rooms']['incoming']>().toEqualTypeOf<{
  'screen-share-started': { from: string };
}>();

// Without binary(), nothing has a `.binary` key and `base.binary` does not exist.
const plain = server({ capabilities: [emits({ 'avatar-saved': t<{ userId: string }>() })] });
// @ts-expect-error: base.binary needs binary()
plain.binary.on('upload-avatar', { run() {} });
plain.on('save-avatar', {
  run(ctx) {
    // @ts-expect-error: ctx.binary needs binary events
    ctx.binary.send('avatar-preview', undefined, { info: null });
  },
});
const plainClient = plain.assemble({ handlers: [] });
// No binary key on a client without binary events.
expectTypeOf<'binary' extends keyof InferClient<typeof plainClient> ? 1 : 0>().toEqualTypeOf<0>();

// A plugin's binary events: `.binary` senders on its ctx, plain names in InferPluginClient,
// and `__<id>::` names in the host's InferClient.
const screens = server({
  scope: 'plugin',
  capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } }), channels()],
});
const stage = screens.channel('stage', {
  capabilities: [binary({ emits: { 'stage-frame': t<null>() } })],
});
const handleShareScreen = screens.binary.on('share-screen-frame', {
  input: v.null(),
  run(ctx, _input, bytes) {
    ctx.binary.send('screen-frame', bytes, { info: { from: ctx.user.id } });
    // @ts-expect-error: 'screen-frame' needs its info
    ctx.binary.send('screen-frame', bytes, { info: null });
  },
});
const handleShareStage = stage.binary.on('share-stage-frame', {
  run(ctx, _input, bytes) {
    ctx.channel.binary.broadcast('stage-frame', bytes, { info: null });
  },
});
const Screens = plugin('acme:screens', {
  definition: screens.assemble({ handlers: [handleShareScreen, handleShareStage] }),
});

expectTypeOf<InferPluginClient<typeof Screens>['binary']>().toEqualTypeOf<{
  incoming: { 'screen-frame': { from: string } };
  outgoing: { 'share-screen-frame': null };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();
expectTypeOf<InferPluginClient<typeof Screens>['channels']['stage']['binary']>().toEqualTypeOf<{
  incoming: { 'stage-frame': null };
  outgoing: { 'share-stage-frame': unknown };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();

const screensHost = server({ capabilities: [Screens()] }).assemble({ handlers: [] });
expectTypeOf<InferClient<typeof screensHost>['binary']>().toEqualTypeOf<{
  incoming: { '__acme:screens::screen-frame': { from: string } };
  outgoing: { '__acme:screens::share-screen-frame': null };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();
expectTypeOf<
  InferClient<typeof screensHost>['channels']['__acme:screens::stage']['binary']
>().toEqualTypeOf<{
  incoming: { 'stage-frame': null };
  outgoing: { 'share-stage-frame': unknown };
  clientRequests: {};
  serverRequests: {};
  streams: {};
}>();

// Two handlers for one name in one scope, one JSON and one binary, is a compile error.
base.assemble({
  // @ts-expect-error: 'upload-avatar' is bound twice
  handlers: [handleUploadAvatar, base.on('upload-avatar', { run() {} })],
});

// With replay listed, each sendReplay has a binary version.
const replayed = server({
  capabilities: [
    binary({ emits: { 'avatar-preview': t<null>() } }),
    emits({ 'avatar-saved': t<{ userId: string }>() }),
    channels(),
    dedup(),
    sequence({ persist: true }),
    replay.history(),
  ],
});
const replayedRooms = replayed.channel(['rooms', 'room:{roomId}'], {
  capabilities: [binary({ emits: { 'screen-frame': t<{ from: string }>() } })],
});
const wire = { deliverySeq: 7, messageId: 'm-7' };

replayed.on('resend-avatar-preview', {
  run(ctx) {
    const bytes = new Uint8Array(4);
    expectTypeOf(
      ctx.binary.sendReplay('avatar-preview', bytes, { info: null, wire }),
    ).toEqualTypeOf<void>();
    ctx.binary.sendReplay('screen-frame', bytes, {
      info: { from: 'u_amara' },
      wire: { ...wire, channel: replayedRooms.at({ roomId: 'general' }) },
    });
    // @ts-expect-error: the info of 'avatar-preview' is null
    ctx.binary.sendReplay('avatar-preview', bytes, { info: { width: 64 }, wire });
    // @ts-expect-error: 'avatar-saved' is a JSON event, so it goes through ctx.sendReplay
    ctx.binary.sendReplay('avatar-saved', bytes, { info: { userId: 'u_amara' }, wire });
    // @ts-expect-error: 'avatar-preview' is a binary event, so it goes through ctx.binary.sendReplay
    ctx.sendReplay('avatar-preview', null, wire);
  },
});

replayedRooms.on('resend-screen-frame', {
  run(ctx) {
    const bytes = new Uint8Array(4);
    ctx.channel.binary.sendReplay?.('screen-frame', bytes, { info: { from: ctx.user.id }, wire });
    // @ts-expect-error: it is absent when replay is not active for the channel
    ctx.channel.binary.sendReplay('screen-frame', bytes, { info: { from: ctx.user.id }, wire });
    // @ts-expect-error: a channel handler has no root sendReplay, binary or JSON
    ctx.binary.sendReplay;
  },
});
