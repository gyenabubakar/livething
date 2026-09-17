import { bind } from '@wskit/server-cloudflare';
import { rejectHttpHandler } from '@wskit/tests-e2e-handlers/lifecycle-hooks-http-reject';

export class RejectHttpServer extends bind(rejectHttpHandler) {}
