import { bind } from '@wskit/server-cloudflare';
import { multiStateDefinition } from '@wskit/tests-e2e-handlers/multi-state';

export class MultiStateServer extends bind(multiStateDefinition) {}
