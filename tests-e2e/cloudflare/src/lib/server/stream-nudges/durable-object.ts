import { server } from '@wskit/server-cloudflare';
import { streamNudgesHandler } from './handler.ts';

export const StreamNudgesServer = server(streamNudgesHandler);
