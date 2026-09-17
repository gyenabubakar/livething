import { bind } from '@wskit/server-cloudflare';
import { hibernationDefinition } from './hibernation/handler.ts';

export class HibernationServer extends bind(hibernationDefinition) {}
