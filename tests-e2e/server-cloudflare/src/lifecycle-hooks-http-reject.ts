import { bind } from '@livething/server-cloudflare';
import { rejectHttpDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks-http-reject';

export class RejectHttpServer extends bind(rejectHttpDefinition) {}
