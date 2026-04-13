import { event } from '@wskit/server';
import * as v from 'valibot';

export const AiSend = event('send', v.object({ text: v.string() }));
export const AiResponse = event('response', v.object({ text: v.string(), model: v.string() }));

export const AiStreamPrompt = event('stream-prompt', v.object({ prompt: v.string() }));
export const AiChunkSchema = v.object({ token: v.string() });

export const GetModel = event('get-model', v.object({}));
export const ModelResponseSchema = v.object({ name: v.string(), maxTokens: v.number() });

export const AiStreamWithNudges = event('stream-with-nudges', v.object({ prompt: v.string() }));
export const NudgePause = event('pause', v.object({}));
export const NudgeSpeedUp = event('speed-up', v.object({ factor: v.number() }));

export const AiStreamError = event('stream-error', v.object({}));
