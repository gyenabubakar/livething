import { bind } from '@wskit/server-cloudflare';
import { heartbeatHibernationDefinition } from './heartbeat-hibernation/handler.ts';

export class HeartbeatHibernationServer extends bind(heartbeatHibernationDefinition) {}
