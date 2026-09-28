import { bind } from '@livething/server-cloudflare';
import { replayCustomCascadeDefinition } from '@livething/tests-e2e-handlers/replay-custom-cascade';

export class ReplayCustomCascadeServer extends bind(replayCustomCascadeDefinition) {}
