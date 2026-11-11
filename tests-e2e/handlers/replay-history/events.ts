import { t } from '@livething/server';
import * as v from 'valibot';

export const ChatMsg = v.object({ text: v.string(), from: v.string() });
export const SendMsg = v.object({ text: v.string() });
export const SendToUser = v.object({ userId: v.string(), text: v.string() });
export const Cursor = v.object({ x: v.number(), y: v.number() });
export const SendCursor = v.object({ x: v.number(), y: v.number() });

export const RoomMsg = v.object({ text: v.string(), from: v.string() });
export const SendRoomMsg = v.object({ text: v.string() });
export const RequestHistory = v.object({});
export const RequestRoomHistory = v.object({});
export const InjectFamilyReplay = v.object({});
export const GetToken = v.object({});

export const TriggerBadReplay = v.object({});
export const TriggerBigIntReplay = v.object({});

export const StartTinyStream = v.object({});
export const ReplayGuardError = v.object({ undeclared: v.string() });

// A plugin-owned event. On the wire it travels namespaced as
// `__e2e:replay::plugin-msg`; the host's top-level replay stores it like any
// other outgoing frame and re-delivers it on reconnect.
export const PingAll = v.object({ text: v.string() });
export const PluginMsg = t<{ text: string }>();
