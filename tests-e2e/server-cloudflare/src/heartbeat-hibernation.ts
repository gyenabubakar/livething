import { bind } from '@wskit/server-cloudflare';
import { heartbeatHibernationHandler } from './heartbeat-hibernation/handler.ts';

export class HeartbeatHibernationServer extends bind(heartbeatHibernationHandler) {}
