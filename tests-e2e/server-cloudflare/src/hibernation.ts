import { bind } from '@wskit/server-cloudflare';
import { hibernationHandler } from './hibernation/handler.ts';

export class HibernationServer extends bind(hibernationHandler) {}
