import { serve } from '@wskit/server-cloudflare';
import { protocolPingsHandler } from './handler.ts';

export const ProtocolPingsServer = serve(protocolPingsHandler);
