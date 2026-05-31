import { server } from '@wskit/server-cloudflare';
import { requestHandler } from './handler.ts';

export const RequestServer = server(requestHandler);
