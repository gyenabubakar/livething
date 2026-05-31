import { server } from '@wskit/server-cloudflare';
import { protocolPingsHandler } from './handler.ts';

export const ProtocolPingsServer = server(protocolPingsHandler);
