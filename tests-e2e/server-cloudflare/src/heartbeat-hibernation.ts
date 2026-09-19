import { bind } from '@livething/server-cloudflare';
import { heartbeatHibernationDefinition } from './heartbeat-hibernation/handler.ts';

export class HeartbeatHibernationServer extends bind(heartbeatHibernationDefinition) {}
