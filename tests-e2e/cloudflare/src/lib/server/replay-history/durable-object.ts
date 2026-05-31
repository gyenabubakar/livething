import { server } from '@wskit/server-cloudflare';
import { replayHandler } from './handler.ts';

export const ReplayServer = server(replayHandler);
