import { serve } from '@wskit/server-cloudflare';
import { handler } from './handler.ts';

export const WebSocketServer = serve(handler, { hibernation: false });
