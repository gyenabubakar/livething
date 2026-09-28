import { bind } from '@livething/server-cloudflare';
import { multifileDefinition } from '@livething/tests-e2e-handlers/multifile';

export class MultifileServer extends bind(multifileDefinition) {}
