import type { InferClient } from '@livething/server';
import { base } from './contract.ts';
import {
  handleBadPayload,
  handleBang,
  handleChat,
  handleCheckDisconnectLog,
  handleCheckInit,
  handleCheckScheduled,
  handleEmitReplayMarker,
  handleFeed,
  handleLookup,
  handlePaginate,
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
    handleEmitReplayMarker,
    handleLookup,
    handleFeed,
    handlePaginate,
    handleTokens,
    handleRoomSendMsg,
  ],
});

export type GroupFullSurfaceClient = InferClient<typeof groupFullSurfaceDefinition>;
