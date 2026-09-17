import { bind } from '@wskit/server-cloudflare';
import { multifileHandler } from '@wskit/tests-e2e-handlers/multifile';

export class MultifileServer extends bind(multifileHandler) {}
