import type { Message } from '~/internal/runtime.ts';
import type { Socket } from '~/socket/api.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { BinaryOf, ChannelsOf, IncomingOf, SocketContract } from '~/types.ts';

/** Push a message object through the real incoming pipeline, even if the socket is disconnected. */
function deliver(socket: object, message: Message): void {
  (socket as unknown as LiveThingSocket)._processIncoming(message);
}

/**
 * Inject a fake message as if the server sent it. It runs through intercept
 * hooks and primitive `onIncoming` hooks, then dispatches to `.on()` handlers —
 * exactly like a real message. Works even when the socket is disconnected.
 *
 * ```ts
 * inject(socket, 'notification', { id: '123', title: 'Test' });
 * ```
 */
export function inject<
  TContract extends SocketContract,
  K extends keyof IncomingOf<TContract> & string,
>(socket: Socket<TContract>, event: K, payload: IncomingOf<TContract>[K]): void {
  deliver(socket, { event, payload, metadata: null });
}

/**
 * How a test names a channel: a fixed channel by its name, one channel of a dynamic family by
 * `{ family, name }`. The family name alone would reach no handle, so it is a type error.
 */
type ChannelTarget<TChannels, TChannel extends keyof TChannels & string> = (
  | TChannel
  | { readonly family: TChannel; readonly name: string }
) &
  (TChannel extends unknown
    ? TChannels[TChannel] extends { addressing: 'dynamic' }
      ? { readonly family: TChannel; readonly name: string }
      : TChannel
    : never);

function channelMetadata(channel: string | { family: string; name: string }) {
  return {
    channel: typeof channel === 'string' ? { name: channel } : { ...channel },
  };
}

/**
 * Inject a fake message into a channel. Tags the frame with channel metadata,
 * so the `channels` primitive routes it to that channel's handlers. Name a fixed
 * channel by its name, and one channel of a dynamic family with `{ family, name }`.
 *
 * ```ts
 * injectChannel(socket, 'message-created', {
 *   channel: 'general',
 *   payload: { text: 'hello', from: 'test-user' },
 * });
 * ```
 */
export function injectChannel<
  TContract extends SocketContract,
  TChannel extends keyof ChannelsOf<TContract> & string,
  K extends keyof IncomingOf<ChannelsOf<TContract>[TChannel]> & string,
>(
  socket: Socket<TContract>,
  event: K,
  message: ChannelMessage<
    ChannelsOf<TContract>,
    TChannel,
    IncomingOf<ChannelsOf<TContract>[TChannel]>[K]
  >,
): void {
  const { channel, payload } = message;
  deliver(socket, { event, payload, metadata: channelMetadata(channel) });
}

/** The channel and the payload of an injected channel message. */
interface ChannelMessage<TChannels, TChannel extends keyof TChannels & string, TPayload> {
  channel: ChannelTarget<TChannels, TChannel>;
  payload: TPayload;
}

/** The info and the bytes of an injected binary message. The bytes default to none. */
interface BinaryMessage<TInfo> {
  info: TInfo;
  bytes?: Uint8Array;
}

/** The channel, the info and the bytes of an injected binary channel message. */
interface ChannelBinaryMessage<
  TChannels,
  TChannel extends keyof TChannels & string,
  TInfo,
> extends BinaryMessage<TInfo> {
  channel: ChannelTarget<TChannels, TChannel>;
}

/**
 * Inject a fake binary message as if the server sent it. It takes the same path as a real
 * binary frame, so it reaches `socket.binary.on(...)` listeners. The bytes default to an
 * empty array. Needs `binary()` on the socket.
 *
 * ```ts
 * injectBinary(socket, 'avatar-preview', {
 *   info: null,
 *   bytes: new Uint8Array([137, 80, 78, 71]),
 * });
 * ```
 */
export function injectBinary<
  TContract extends SocketContract,
  K extends keyof IncomingOf<BinaryOf<TContract>> & string,
>(
  socket: Socket<TContract>,
  event: K,
  message: BinaryMessage<IncomingOf<BinaryOf<TContract>>[K]>,
): void {
  const { info, bytes = new Uint8Array(0) } = message;
  deliver(socket, { event, payload: info, metadata: null, bytes });
}

/**
 * Inject a fake binary message into a channel, so it reaches that channel handle's
 * `binary.on(...)` listeners. Name a fixed channel by its name, and one channel of a
 * dynamic family with `{ family, name }`.
 *
 * ```ts
 * injectChannelBinary(socket, 'screen-frame', {
 *   channel: { family: 'rooms', name: 'room:general' },
 *   info: { from: 'u_amara' },
 *   bytes: pictureBytes,
 * });
 * ```
 */
export function injectChannelBinary<
  TContract extends SocketContract,
  TChannel extends keyof ChannelsOf<TContract> & string,
  K extends keyof IncomingOf<BinaryOf<ChannelsOf<TContract>[TChannel]>> & string,
>(
  socket: Socket<TContract>,
  event: K,
  message: ChannelBinaryMessage<
    ChannelsOf<TContract>,
    TChannel,
    IncomingOf<BinaryOf<ChannelsOf<TContract>[TChannel]>>[K]
  >,
): void {
  const { channel, info, bytes = new Uint8Array(0) } = message;
  deliver(socket, { event, payload: info, metadata: channelMetadata(channel), bytes });
}
