import { server } from '@wskit/server-cloudflare';
import { heartbeatHibernationHandler } from './heartbeat-hibernation/handler.ts';

export const HeartbeatHibernationServer = server(heartbeatHibernationHandler);
