import { bind } from '@livething/server-cloudflare';
import { replayFamilyKeyEqualsNameDefinition } from '@livething/tests-e2e-handlers/replay-family-key-equals-name';

export class ReplayFamilyKeyEqualsNameServer extends bind(replayFamilyKeyEqualsNameDefinition) {}
