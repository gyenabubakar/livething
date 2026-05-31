import { server } from '@wskit/server-cloudflare';
import { replayCustomHandler } from './handler.ts';

export const ReplayCustomServer = server(replayCustomHandler);
