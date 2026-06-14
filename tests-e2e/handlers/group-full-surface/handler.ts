import type { InferClient } from '@wskit/server';
import { base } from './contract.ts';
import {
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
  handleTick,
  handleRoomSendMsg,
} from './group.ts';

export const groupFullSurfaceHandler = base.assemble(
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
  handleTick,
  handleRoomSendMsg,
);

export type GroupFullSurfaceClient = InferClient<typeof groupFullSurfaceHandler>;
