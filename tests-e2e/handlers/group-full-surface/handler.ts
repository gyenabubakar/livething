import type { InferClient } from '@livething/server';
import { base } from './contract.ts';
import {
  handleBadPayload,
  handleBang,
  handleChat,
  handleCheckDisconnectLog,
  handleCheckInit,
  handleCheckScheduled,
  handleFeed,
  handleLookup,
  handleRoomSendMsg,
  handleStartTick,
  handleTokens,
} from './group.ts';

export const groupFullSurfaceDefinition = base.assemble({
  handlers: [
    handleChat,
    handleBang,
    handleBadPayload,
    handleCheckInit,
    handleCheckDisconnectLog,
    handleCheckScheduled,
    handleStartTick,
    handleLookup,
    handleFeed,
    handleTokens,
    handleRoomSendMsg,
  ],
});

export type GroupFullSurfaceClient = InferClient<typeof groupFullSurfaceDefinition>;
