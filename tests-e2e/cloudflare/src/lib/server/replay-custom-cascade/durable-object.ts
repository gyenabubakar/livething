import { server } from '@wskit/server-cloudflare';
import { replayCustomCascadeHandler } from './handler.ts';

export const ReplayCustomCascadeServer = server(replayCustomCascadeHandler);
