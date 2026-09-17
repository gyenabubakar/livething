import { bind } from '@wskit/server-cloudflare';
import { multifileDefinition } from '@wskit/tests-e2e-handlers/multifile';

export class MultifileServer extends bind(multifileDefinition) {}
