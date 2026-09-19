import { bind } from '@livething/server-cloudflare';
import { multiStateDefinition } from '@livething/tests-e2e-handlers/multi-state';

export class MultiStateServer extends bind(multiStateDefinition) {}
