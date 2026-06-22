import { t } from '@wskit/server';
import * as v from 'valibot';

export const ChatMsg = v.object({ text: v.string(), from: v.string() });
export const SendMsg = v.object({ text: v.string() });
export const Cursor = v.object({ x: v.number(), y: v.number() });
export const SendCursor = v.object({ x: v.number(), y: v.number() });

export const RoomMsg = v.object({ text: v.string(), from: v.string() });
export const SendRoomMsg = v.object({ text: v.string() });
export const RequestHistory = v.object({});
export const RequestRoomHistory = v.object({});
export const InjectFamilyReplay = v.object({});
export const GetToken = v.object({});
export const TokenResponse = v.object({ token: v.string() });

export const TriggerBadReplay = v.object({});
export const TriggerBigIntReplay = v.object({});

export const StartTinyStream = v.object({});
export const TinyChunk = t<{ value: string }>();
export const ReplayGuardError = v.object({ undeclared: v.string() });
