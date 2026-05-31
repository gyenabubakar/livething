import { server } from '@wskit/server-cloudflare';
import { streamBasicHandler } from './handler.ts';

export const StreamBasicServer = server(streamBasicHandler);
