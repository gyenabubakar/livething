import { server } from '@wskit/server-cloudflare';
import { hibernationHandler } from './hibernation/handler.ts';

export class HibernationServer extends server(hibernationHandler) {}
